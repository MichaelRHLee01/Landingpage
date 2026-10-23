/**
 * Square Fare — data access layer
 *
 * WHY THIS FILE EXISTS
 *
 * The Airtable version of GET /api/orders/:token issues, per request:
 *   - 1 query for the client
 *   - 1 query for the orders
 *   - 1 query for the weekly menu
 *   - 1 query PER MENU ITEM for its ingredients        (~18)
 *   - 1 query PER INGREDIENT for protein option names  (~8 per protein group)
 *   - 1 query per getIngredientName() call
 *
 * That is somewhere north of 40 sequential round trips on a cold cache, each
 * one a network hop to api.airtable.com. Caching variants and standard sauces
 * (as server.js does) papers over the worst of it but cannot remove the shape
 * of the problem: the work is O(dishes x ingredients) in round trips.
 *
 * Here it is a FIXED number of queries — 7 — regardless of how many dishes,
 * ingredients, or orders are involved. Everything else is an in-process join.
 * That is the actual latency win. Caching then sits on top of an already-fast
 * path instead of hiding a slow one.
 *
 * The output shape is byte-compatible with what MealPlanViewer.js expects, so
 * this can be dropped in without touching the frontend.
 */

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

// server.js hardcodes these three as the always-available sauce options.
const STANDARD_SAUCE_CODES = ['SF Vinegar & Oil', 'SF Citrus Vinaigrette', '9156 Lemon'];

// Placeholder macros. The Airtable base never stored per-order nutrition, so
// server.js fell back to these constants; kept identical to avoid changing
// the numbers the UI displays. Replace when real macro data lands.
const DEFAULT_MACROS = { calories: 150, carbs: 15, protein: 5, fat: 8, fiber: 3 };

/**
 * Normalises 'Dinner Subscriptions' / 'Dinner ' / 'Dinner' -> 'Dinner'.
 * The Airtable data is inconsistent here and the frontend groups strictly on
 * the four canonical values, so anything unnormalised silently vanishes from
 * the UI. This was a real class of bug in the original.
 */
function canonicalMeal(raw) {
    if (!raw) return 'Snack';
    const s = String(raw).trim();
    for (const m of MEAL_TYPES) {
        if (s.toLowerCase().startsWith(m.toLowerCase())) return m;
    }
    return 'Snack';
}

function groupBy(rows, key) {
    const out = new Map();
    for (const r of rows) {
        const k = r[key];
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(r);
    }
    return out;
}

class SquareFareRepo {
    constructor(db) {
        this.db = db;
        this._prepare();
    }

    _prepare() {
        const db = this.db;

        this.qClients = db.prepare(
            `SELECT * FROM clients WHERE unique_id = ? ORDER BY meal`);

        this.qOrders = db.prepare(
            `SELECT o.* FROM open_orders o
               JOIN clients c ON c.id = o.client_id
              WHERE c.unique_id = ? AND o.quantity > 0
              ORDER BY o.delivery_date, o.meal_portion, o.item_name`);

        // Both ingredient kinds for a whole set of orders in ONE query.
        this.qOrderIngredients = (n) => db.prepare(
            `SELECT oi.order_id, oi.kind, oi.sort_order,
                    i.id AS ingredient_id, i.ingredient_name, i.ingredient_id AS code, i.component
               FROM order_ingredients oi
               JOIN ingredients i ON i.id = oi.ingredient_id
              WHERE oi.order_id IN (${new Array(n).fill('?').join(',')})
              ORDER BY oi.sort_order`);

        // Menu + recipe ingredients in one shot. The Airtable version did this
        // with one extra request per menu row.
        this.qAvailable = db.prepare(
            `SELECT m.internal_dish_id AS dish_id, m.item_name, m.meals, m.image_url,
                    i.id AS ingredient_id, i.ingredient_name, i.component, di.sort_order
               FROM weekly_menu m
               JOIN dishes d
                 ON d.dish_id = m.internal_dish_id
                AND (', ' || d.type_of_meal || ', ') LIKE ('%, ' || m.meals || ', %')
               JOIN dish_ingredients di ON di.dish_pk = d.id
               JOIN ingredients i ON i.id = di.ingredient_id
              WHERE m.status = 'active' AND m.exclude_from_subscriptions = 0
              ORDER BY m.internal_dish_id, di.sort_order`);

        this.qVariants = db.prepare(
            `SELECT v.id AS variant_id, v.variant_name, v.variant_type, v.applicable_to, v.price,
                    i.id AS ingredient_id, i.ingredient_name, i.component
               FROM variants v
               JOIN variant_ingredients vi ON vi.variant_id = v.id
               JOIN ingredients i ON i.id = vi.ingredient_id
              WHERE v.availability = 1`);

        this.qStandardSauces = db.prepare(
            `SELECT id, ingredient_name FROM ingredients
              WHERE ingredient_id IN (${STANDARD_SAUCE_CODES.map(() => '?').join(',')})`);

        this.qSubscriptions = db.prepare(
            `SELECT meal, meals_included, next_delivery_date
               FROM subscriptions WHERE customer_name = ?`);
    }

    // -----------------------------------------------------------------------
    // Reference data. Small, changes rarely, safe to cache aggressively.
    // -----------------------------------------------------------------------

    getReferenceData() {
        const variantRows = this.qVariants.all();

        // ingredientId -> variant type, so "which group does this protein belong to"
        // is a Map lookup instead of a linear scan over every variant.
        const typeByIngredient = new Map();
        const byType = new Map();

        for (const r of variantRows) {
            typeByIngredient.set(r.ingredient_id, r.variant_type);
            if (!byType.has(r.variant_type)) byType.set(r.variant_type, []);
            byType.get(r.variant_type).push(r);
        }

        const standardSauces = this.qStandardSauces.all(...STANDARD_SAUCE_CODES).map(s => ({
            id: s.id, name: s.ingredient_name, isActive: false,
        }));
        standardSauces.push({ id: null, name: 'No Sauce', isActive: false });

        return { typeByIngredient, byType, standardSauces };
    }

    /**
     * Protein options for a given current protein + meal type.
     * Pure function over already-loaded reference data — zero queries.
     */
    buildProteinOptions(currentProteinId, mealType, ref) {
        if (!currentProteinId) return { options: [], currentProtein: null };

        const variantType = ref.typeByIngredient.get(currentProteinId);
        if (!variantType) return { options: [], currentProtein: null };

        const options = [];
        for (const r of ref.byType.get(variantType) || []) {
            if (!String(r.applicable_to || '').includes(mealType)) continue;
            options.push({
                id: r.ingredient_id,
                name: r.ingredient_name,
                variantName: r.variant_name,
                price: r.price || 0,
                isActive: r.ingredient_id === currentProteinId,
                // Mirrors the Egg special-case in server.js: two distinct egg
                // records share a name, so the variant name disambiguates them.
                displayName: r.ingredient_name === 'Egg'
                    ? `${r.ingredient_name} ${r.variant_name}`
                    : r.ingredient_name,
            });
        }

        return {
            currentProtein: { id: currentProteinId, name: options.find(o => o.isActive)?.name || 'Unknown' },
            options,
        };
    }

    /**
     * Sauce / garnish / veggie / starch option sets for one dish.
     * Also a pure function — no queries.
     */
    buildComponentOptions({ current, original, mealType, ref }) {
        const nameOf = new Map();
        for (const x of [...current, ...original]) nameOf.set(x.ingredient_id, x.ingredient_name);

        const currentIds = new Set(current.map(x => x.ingredient_id));
        const pick = (list, comp) => list.filter(x => x.component === comp);

        // --- sauces: replace-only, plus the three standards and a No Sauce ---
        const currentSauces = pick(current, 'Sauce');
        const sauceOptions = ref.standardSauces.map(s => ({
            ...s, isActive: currentSauces.some(c => c.ingredient_id === s.id),
        }));
        for (const s of pick(original, 'Sauce')) {
            if (!sauceOptions.some(o => o.id === s.ingredient_id)) {
                sauceOptions.unshift({
                    id: s.ingredient_id, name: s.ingredient_name,
                    isActive: currentIds.has(s.ingredient_id),
                });
            }
        }
        for (const s of currentSauces) {
            if (!sauceOptions.some(o => o.id === s.ingredient_id)) {
                sauceOptions.unshift({ id: s.ingredient_id, name: s.ingredient_name, isActive: true });
            }
        }
        const noSauce = sauceOptions.find(o => o.id === null);
        if (noSauce) noSauce.isActive = currentSauces.length === 0;

        // --- garnishes: toggleable, union of original + current ---
        const seenG = new Set();
        const garnishOptions = [];
        for (const g of [...pick(current, 'Garnish'), ...pick(original, 'Garnish')]) {
            if (seenG.has(g.ingredient_id)) continue;
            seenG.add(g.ingredient_id);
            garnishOptions.push({
                id: g.ingredient_id, name: g.ingredient_name,
                isActive: currentIds.has(g.ingredient_id),
            });
        }

        // --- veggies: toggleable ---
        const seenV = new Set();
        const veggieOptions = [];
        for (const v of [...pick(current, 'Veggies'), ...pick(original, 'Veggies')]) {
            if (seenV.has(v.ingredient_id)) continue;
            seenV.add(v.ingredient_id);
            veggieOptions.push({
                id: v.ingredient_id, name: v.ingredient_name,
                isActive: currentIds.has(v.ingredient_id),
            });
        }

        // --- starches: replace-only, includes variant-provided alternatives ---
        const seenS = new Set();
        const starchOptions = [];
        for (const s of [...pick(current, 'Starch'), ...pick(original, 'Starch')]) {
            if (seenS.has(s.ingredient_id)) continue;
            seenS.add(s.ingredient_id);
            starchOptions.push({
                id: s.ingredient_id, name: s.ingredient_name,
                isActive: currentIds.has(s.ingredient_id),
            });
        }
        for (const r of ref.byType.get('Starch Substitution') || []) {
            if (!String(r.applicable_to || '').includes(mealType)) continue;
            if (seenS.has(r.ingredient_id)) continue;
            seenS.add(r.ingredient_id);
            starchOptions.push({
                id: r.ingredient_id, name: r.ingredient_name,
                isActive: currentIds.has(r.ingredient_id),
            });
        }

        return { sauceOptions, garnishOptions, veggieOptions, starchOptions };
    }

    // -----------------------------------------------------------------------
    // The main read path. 7 queries, fixed.
    // -----------------------------------------------------------------------

    getMealPlan(token) {
        // [1] clients
        const clients = this.qClients.all(token);
        if (!clients.length) return null;

        const profile = clients[0];
        const customerName = `${profile.first_name} ${profile.last_name}`;

        // [2] orders
        const orders = this.qOrders.all(token);

        // [3] every ingredient for every order, both kinds
        let ingByOrder = new Map();
        if (orders.length) {
            const ids = orders.map(o => o.id);
            const rows = this.qOrderIngredients(ids.length).all(...ids);
            ingByOrder = groupBy(rows, 'order_id');
        }

        // [4] + [5] menu and recipes
        const availableRows = this.qAvailable.all();

        // [6] + [7] variants and standard sauces
        const ref = this.getReferenceData();

        const subscriptions = this.qSubscriptions.all(customerName).map(s => ({
            meal: s.meal,
            mealsIncluded: s.meals_included,
            deliveryDate: s.next_delivery_date,
        }));

        // ---- assemble ordered dishes -------------------------------------
        const orderedDishes = orders.map(o => {
            const all = ingByOrder.get(o.id) || [];
            const original = all.filter(r => r.kind === 'original');
            const finals = all.filter(r => r.kind === 'final');
            const current = finals.length ? finals : original;
            const mealType = canonicalMeal(o.meal_portion);

            const proteinId = current.find(x => x.component === 'Meat')?.ingredient_id || null;
            const opts = this.buildComponentOptions({ current, original, mealType, ref });

            const allUnique = [];
            const seen = new Set();
            for (const x of [...original, ...current]) {
                if (seen.has(x.ingredient_id)) continue;
                seen.add(x.ingredient_id);
                allUnique.push({ id: x.ingredient_id, name: x.ingredient_name });
            }

            return {
                recordId: o.id,
                dishId: o.dish_id,
                itemName: o.item_name,
                quantity: o.quantity,
                deliveryDate: o.delivery_date,
                email: o.email,
                orderSubscriptionId: o.order_subscription_id,
                meal: mealType,
                nutritionNotes: o.nutrition_notes || '',
                originalIngredients: original.map(x => x.ingredient_id),
                finalIngredients: finals.map(x => x.ingredient_id),
                ingredients: current.map(x => x.ingredient_name),
                hasCustomIngredients: finals.length > 0,
                allIngredients: allUnique,
                ...opts,
                ...DEFAULT_MACROS,
                proteinOptions: this.buildProteinOptions(proteinId, mealType, ref),
                imageUrl: null,   // filled from the menu map below
                isOrdered: true,
            };
        });

        // ---- assemble available (not-yet-ordered) dishes -------------------
        const menuByDish = new Map();
        for (const r of availableRows) {
            const key = `${r.dish_id}::${r.meals}`;
            if (!menuByDish.has(key)) {
                menuByDish.set(key, {
                    dishId: r.dish_id, itemName: r.item_name,
                    mealType: canonicalMeal(r.meals), imageUrl: r.image_url, ings: [],
                });
            }
            menuByDish.get(key).ings.push({
                ingredient_id: r.ingredient_id,
                ingredient_name: r.ingredient_name,
                component: r.component,
            });
        }

        // Back-fill images onto ordered dishes without another query.
        const imageByDish = new Map();
        for (const m of menuByDish.values()) imageByDish.set(m.dishId, m.imageUrl);
        for (const d of orderedDishes) d.imageUrl = imageByDish.get(d.dishId) || null;

        const availableDishes = [...menuByDish.values()].map(m => {
            const proteinId = m.ings.find(x => x.component === 'Meat')?.ingredient_id || null;
            const opts = this.buildComponentOptions({
                current: m.ings, original: m.ings, mealType: m.mealType, ref,
            });
            return {
                recordId: null,
                dishId: m.dishId,
                itemName: m.itemName,
                quantity: 0,
                email: profile.email,
                orderSubscriptionId: null,
                meal: m.mealType,
                nutritionNotes: '',
                originalIngredients: m.ings.map(x => x.ingredient_id),
                finalIngredients: [],
                ingredients: m.ings.map(x => x.ingredient_name),
                hasCustomIngredients: false,
                allIngredients: m.ings.map(x => ({ id: x.ingredient_id, name: x.ingredient_name })),
                ...opts,
                ...DEFAULT_MACROS,
                proteinOptions: this.buildProteinOptions(proteinId, m.mealType, ref),
                imageUrl: m.imageUrl,
                isOrdered: false,
                isAvailable: true,
            };
        });

        // ---- fan available dishes across each delivery date ---------------
        const byDate = groupBy(orderedDishes, 'deliveryDate');
        const combined = [];

        if (byDate.size === 0) {
            for (const d of availableDishes) combined.push({ ...d, deliveryDate: 'Available' });
        } else {
            for (const [date, ordered] of byDate) {
                combined.push(...ordered);
                for (const a of availableDishes) {
                    const taken = ordered.some(o => o.dishId === a.dishId && o.meal === a.meal);
                    if (!taken) combined.push({ ...a, deliveryDate: date });
                }
            }
        }

        const currentTotals = orderedDishes.reduce((t, o) => ({
            calories: t.calories + o.calories * o.quantity,
            carbs: t.carbs + o.carbs * o.quantity,
            protein: t.protein + o.protein * o.quantity,
            fat: t.fat + o.fat * o.quantity,
            fiber: t.fiber + o.fiber * o.quantity,
        }), { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 });

        const goals = {
            calories: profile.goal_calories || 0,
            carbs: profile.goal_carbs_g || 0,
            protein: profile.goal_protein_g || 0,
            fat: profile.goal_fat_g || 0,
            fiber: profile.goal_fiber_g || 0,
            notes: profile.notes || '',
            snacksPerDay: profile.snacks_per_day || 0,
        };

        return {
            customer: { name: customerName, email: profile.email },
            nutritionGoals: goals,
            currentTotals,
            orders: combined,
            subscriptions,
            summary: {
                totalMeals: orderedDishes.length,
                calorieProgress: goals.calories > 0
                    ? (currentTotals.calories / goals.calories * 100).toFixed(1) : 0,
            },
        };
    }

    // -----------------------------------------------------------------------
    // Writes. Each is a single transaction — the Airtable version could leave
    // an order half-updated if the second call failed, since there was no way
    // to roll back a partial multi-field write.
    // -----------------------------------------------------------------------

    _ensureFinalSeeded(orderId) {
        const hasFinal = this.db.prepare(
            `SELECT 1 FROM order_ingredients WHERE order_id = ? AND kind = 'final' LIMIT 1`)
            .get(orderId);
        if (hasFinal) return;
        this.db.prepare(
            `INSERT INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
             SELECT order_id, ingredient_id, 'final', sort_order
               FROM order_ingredients WHERE order_id = ? AND kind = 'original'`).run(orderId);
    }

    _logEdit(orderId, message) {
        const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        this.db.prepare(
            `UPDATE open_orders
                SET customer_edits = COALESCE(customer_edits, '') || ?,
                    updated_at = datetime('now')
              WHERE id = ?`).run(`${stamp} - ${message};\n`, orderId);
    }

    _finalIds(orderId) {
        return this.db.prepare(
            `SELECT ingredient_id FROM order_ingredients
              WHERE order_id = ? AND kind = 'final' ORDER BY sort_order`)
            .all(orderId).map(r => r.ingredient_id);
    }

    _name(id) {
        if (!id) return 'No Sauce';
        return this.db.prepare(`SELECT ingredient_name FROM ingredients WHERE id = ?`)
            .get(id)?.ingredient_name || id;
    }

    /** Toggle any ingredient on/off (veggies, garnishes). */
    toggleIngredient(orderId, ingredientId, shouldActivate) {
        return this.db.transaction(() => {
            this._ensureFinalSeeded(orderId);
            if (shouldActivate) {
                const max = this.db.prepare(
                    `SELECT COALESCE(MAX(sort_order), 0) m FROM order_ingredients
                      WHERE order_id = ? AND kind = 'final'`).get(orderId).m;
                this.db.prepare(
                    `INSERT OR IGNORE INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
                     VALUES (?, ?, 'final', ?)`).run(orderId, ingredientId, max + 1);
            } else {
                this.db.prepare(
                    `DELETE FROM order_ingredients
                      WHERE order_id = ? AND ingredient_id = ? AND kind = 'final'`)
                    .run(orderId, ingredientId);
            }
            this._logEdit(orderId,
                `${this._name(ingredientId)} ${shouldActivate ? 'added' : 'removed'}`);
            return this._finalIds(orderId);
        })();
    }

    /** Replace the single ingredient occupying a component slot (sauce, starch, protein). */
    replaceComponent(orderId, component, newIngredientId, opts = {}) {
        return this.db.transaction(() => {
            this._ensureFinalSeeded(orderId);

            const outgoing = this.db.prepare(
                `SELECT oi.ingredient_id FROM order_ingredients oi
                   JOIN ingredients i ON i.id = oi.ingredient_id
                  WHERE oi.order_id = ? AND oi.kind = 'final' AND i.component = ?`)
                .all(orderId, component).map(r => r.ingredient_id);

            this.db.prepare(
                `DELETE FROM order_ingredients
                  WHERE order_id = ? AND kind = 'final' AND ingredient_id IN (
                        SELECT id FROM ingredients WHERE component = ?)`)
                .run(orderId, component);

            if (newIngredientId) {
                const max = this.db.prepare(
                    `SELECT COALESCE(MAX(sort_order), 0) m FROM order_ingredients
                      WHERE order_id = ? AND kind = 'final'`).get(orderId).m;
                this.db.prepare(
                    `INSERT OR IGNORE INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
                     VALUES (?, ?, 'final', ?)`).run(orderId, newIngredientId, max + 1);
            }

            const from = outgoing.length ? this._name(outgoing[0]) : 'nothing';
            const to = this._name(newIngredientId);
            this._logEdit(orderId, opts.upgradePrice > 0
                ? `${from} upgraded to ${to} (+$${opts.upgradePrice} premium)`
                : `${from} replaced with ${to}`);

            if (component === 'Meat') {
                this.db.prepare(`UPDATE open_orders SET selected_protein = ? WHERE id = ?`)
                    .run(to, orderId);
            }
            return this._finalIds(orderId);
        })();
    }

    /** Add a dish to the plan. Returns the new order row's id. */
    addDish({ token, dishId, mealType, deliveryDate }) {
        return this.db.transaction(() => {
            const client = this.db.prepare(
                `SELECT * FROM clients WHERE unique_id = ? AND meal = ?`).get(token, mealType);
            if (!client) throw new Error(`No client record for meal type: ${mealType}`);

            const dupe = this.db.prepare(
                `SELECT id FROM open_orders
                  WHERE client_id = ? AND dish_id = ? AND meal_portion LIKE ?
                    AND delivery_date = ? AND quantity > 0`)
                .get(client.id, dishId, `${mealType}%`, deliveryDate);
            if (dupe) { const e = new Error('Dish already exists'); e.code = 'DUPLICATE'; e.recordId = dupe.id; throw e; }

            const dish = this.db.prepare(
                `SELECT d.id FROM dishes d
                  WHERE d.dish_id = ? AND (', ' || d.type_of_meal || ', ') LIKE ?`)
                .get(dishId, `%, ${mealType}, %`);
            if (!dish) throw new Error(`No recipe for dish ${dishId} / ${mealType}`);

            const ings = this.db.prepare(
                `SELECT di.ingredient_id, di.sort_order, i.component
                   FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
                  WHERE di.dish_pk = ? ORDER BY di.sort_order`).all(dish.id);

            const menu = this.db.prepare(
                `SELECT item_name FROM weekly_menu
                  WHERE internal_dish_id = ? AND meals = ?`).get(dishId, mealType);

            const ref = this.db.prepare(
                `SELECT order_subscription_id FROM open_orders
                  WHERE client_id = ? LIMIT 1`).get(client.id);

            const orderId = 'rec' + Math.random().toString(36).slice(2, 16).padEnd(14, '0');
            const itemName = menu?.item_name || `Dish ${dishId}`;
            const protein = ings.find(x => x.component === 'Meat');

            this.db.prepare(
                `INSERT INTO open_orders (id, order_subscription_id, quantity, source, item_name,
                    selected_protein, meal_portion, customer_name, delivery_date, dish_id,
                    client_id, nutrition_notes, customer_edits, email, order_placed_at)
                 VALUES (?, ?, 1, 'Subscription Landing Page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))`)
                .run(orderId, ref?.order_subscription_id || String(Date.now()).slice(-6), itemName,
                    protein ? this._name(protein.ingredient_id) : '',
                    `${mealType} Subscriptions`,
                    `${client.first_name} ${client.last_name}`,
                    deliveryDate, dishId, client.id, client.notes || '',
                    `${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} - ${itemName} added (quantity 0→1);\n`,
                    client.email);

            const ins = this.db.prepare(
                `INSERT INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
                 VALUES (?, ?, ?, ?)`);
            for (const x of ings) ins.run(orderId, x.ingredient_id, 'original', x.sort_order);

            return { recordId: orderId, itemName, dishId, quantity: 1 };
        })();
    }

    /** Remove a serving. Cascades to order_ingredients via FK. */
    removeOrder(orderId) {
        this.db.prepare(`DELETE FROM open_orders WHERE id = ?`).run(orderId);
    }

    /** Duplicate an order row N times (the "increase quantity" path). */
    duplicateOrder(orderId, times) {
        return this.db.transaction(() => {
            const src = this.db.prepare(`SELECT * FROM open_orders WHERE id = ?`).get(orderId);
            if (!src) throw new Error('Order not found');
            const ids = [];
            for (let i = 0; i < times; i++) {
                const nid = 'rec' + Math.random().toString(36).slice(2, 16).padEnd(14, '0');
                this.db.prepare(
                    `INSERT INTO open_orders (id, order_subscription_id, quantity, source, item_name,
                        selected_protein, squarespace_item_id, meal_portion, customer_name,
                        delivery_date, dish_id, client_id, nutrition_notes, customer_edits,
                        email, meal_sticker, order_placed_at)
                     SELECT ?, order_subscription_id, 1, 'Subscription Landing Page', item_name,
                        selected_protein, squarespace_item_id, meal_portion, customer_name,
                        delivery_date, dish_id, client_id, nutrition_notes, customer_edits,
                        email, meal_sticker, date('now')
                       FROM open_orders WHERE id = ?`).run(nid, orderId);
                this.db.prepare(
                    `INSERT INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
                     SELECT ?, ingredient_id, kind, sort_order
                       FROM order_ingredients WHERE order_id = ?`).run(nid, orderId);
                ids.push(nid);
            }
            return ids;
        })();
    }
}

module.exports = { SquareFareRepo, canonicalMeal, MEAL_TYPES };
