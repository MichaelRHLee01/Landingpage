/**
 * Square Fare — server (SQLite)
 *
 * Drop-in replacement for server.js. Same routes, same request bodies, same
 * response shapes, so MealPlanViewer.js needs no changes at all.
 *
 *   node server.sqlite.js
 *
 * The original server.js is left on disk untouched as the reference for what
 * the Airtable behaviour was. Do not delete it until this has been exercised
 * against every UI interaction.
 *
 * WHAT MOVED
 *
 * All data access lives in db/queries.js now. What remains here is genuinely
 * only HTTP: parse the request, call one repo method, shape the response. The
 * original mixed both concerns, which is why it was 1500 lines and why none of
 * it could be tested without standing up a server.
 */

const express = require('express');
const { repo, cachedRepo, cache, DB_PATH, backendName, db } = require('./db');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Request timing. The original scattered console.time() calls through the
// handler body; one middleware covers every route and stays out of the way.
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`${res.statusCode}  ${ms.toFixed(1).padStart(7)}ms  ${req.method} ${req.originalUrl}`);
    });
    next();
});

/** Wraps an async handler so a throw becomes a 500 instead of an unhandled rejection. */
const handle = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`  ${req.method} ${req.originalUrl} failed:`, err.message);
        if (res.headersSent) return;
        res.status(err.status || 500).json({
            error: err.publicMessage || 'Internal server error',
            details: err.message,
        });
    });
};

/** Every mutating route needs a valid recordId; the UI sends null while a card is still saving. */
function requireRecordId(recordId) {
    if (!recordId) {
        const e = new Error('Please wait for the dish to finish saving before customizing');
        e.status = 400;
        e.publicMessage = 'Please wait for the dish to finish saving before customizing';
        throw e;
    }
}

// ===========================================================================
// READ
// ===========================================================================

app.get('/api/orders/:token', handle(async (req, res) => {
    const plan = await cachedRepo.getMealPlan(req.params.token);
    if (!plan) return res.status(404).json({ error: 'Customer not found' });
    res.json(plan);
}));

// ===========================================================================
// INGREDIENT TOGGLES
// ===========================================================================

// The snack ingredient list sends a NAME rather than an id, unlike every other
// toggle. Resolving it here keeps that quirk at the HTTP boundary instead of
// leaking into the repo.
app.patch('/api/orders/:token/ingredients/toggle', handle(async (req, res) => {
    const { recordId, ingredientName, shouldActivate } = req.body;
    requireRecordId(recordId);

    const candidates = db.prepare(
        `SELECT DISTINCT i.id, i.ingredient_name
           FROM order_ingredients oi
           JOIN ingredients i ON i.id = oi.ingredient_id
          WHERE oi.order_id = ?`).all(recordId);

    const target = candidates.find(c =>
        c.ingredient_name.toLowerCase().includes(String(ingredientName).toLowerCase()));

    if (!target) return res.status(404).json({ error: 'Ingredient not found' });

    const finalIds = await cachedRepo.toggleIngredient(recordId, target.id, shouldActivate);

    const names = db.prepare(
        `SELECT i.ingredient_name FROM order_ingredients oi
           JOIN ingredients i ON i.id = oi.ingredient_id
          WHERE oi.order_id = ? AND oi.kind = 'final' ORDER BY oi.sort_order`)
        .all(recordId).map(r => r.ingredient_name);

    res.json({
        success: true,
        message: `Ingredient "${ingredientName}" ${shouldActivate ? 'added' : 'removed'}`,
        activeIngredients: names,
        finalIngredientIds: finalIds,
        allIngredients: candidates.map(c => ({ id: c.id, name: c.ingredient_name })),
    });
}));

app.patch('/api/orders/:token/toggle-veggie', handle(async (req, res) => {
    const { recordId, veggieId, shouldActivate } = req.body;
    requireRecordId(recordId);
    const updatedIngredientIds = await cachedRepo.toggleIngredient(recordId, veggieId, shouldActivate);
    res.json({
        success: true,
        message: `Veggie ${shouldActivate ? 'added' : 'removed'}`,
        updatedIngredientIds,
    });
}));

app.patch('/api/orders/:token/toggle-garnish', handle(async (req, res) => {
    const { recordId, garnishId, shouldActivate } = req.body;
    requireRecordId(recordId);
    const updatedIngredientIds = await cachedRepo.toggleIngredient(recordId, garnishId, shouldActivate);
    res.json({
        success: true,
        message: `Garnish ${shouldActivate ? 'added' : 'removed'}`,
        updatedIngredientIds,
    });
}));

// ===========================================================================
// COMPONENT REPLACEMENTS  (single-slot: protein, sauce, starch)
// ===========================================================================

app.patch('/api/orders/:token/replace-protein', handle(async (req, res) => {
    const { recordId, newProteinId, upgradePrice = 0 } = req.body;
    requireRecordId(recordId);

    const updatedIngredientIds = await cachedRepo.replaceComponent(
        recordId, 'Meat', newProteinId, { upgradePrice });

    const name = db.prepare(`SELECT ingredient_name n FROM ingredients WHERE id = ?`)
        .get(newProteinId)?.n || 'protein';

    res.json({
        success: true,
        message: upgradePrice > 0
            ? `Protein upgraded to ${name} (+$${upgradePrice})`
            : `Protein updated to ${name}`,
        updatedIngredientIds,
        upgradePrice,
    });
}));

app.patch('/api/orders/:token/replace-sauce', handle(async (req, res) => {
    const { recordId, newSauceId } = req.body;
    requireRecordId(recordId);
    // newSauceId is null for the "No Sauce" option — replaceComponent handles that.
    const updatedIngredientIds = await cachedRepo.replaceComponent(recordId, 'Sauce', newSauceId);
    res.json({ success: true, message: 'Sauce updated successfully', updatedIngredientIds });
}));

app.patch('/api/orders/:token/toggle-starch', handle(async (req, res) => {
    const { recordId, starchId } = req.body;
    requireRecordId(recordId);
    // Named "toggle" but is replace-only, matching the frontend's behaviour.
    const updatedIngredientIds = await cachedRepo.replaceComponent(recordId, 'Starch', starchId);
    res.json({ success: true, message: 'Starch updated successfully', updatedIngredientIds });
}));

// ===========================================================================
// ADD / QUANTITY
// ===========================================================================

app.post('/api/orders/:token/add-dish', handle(async (req, res) => {
    const { dishId, mealType, requestedDeliveryDate } = req.body;

    if (!dishId || !mealType) {
        return res.status(400).json({
            error: 'Missing required fields',
            details: 'dishId and mealType are required',
        });
    }

    let deliveryDate = requestedDeliveryDate;
    if (!deliveryDate) {
        deliveryDate = db.prepare(
            `SELECT o.delivery_date d FROM open_orders o
               JOIN clients c ON c.id = o.client_id
              WHERE c.unique_id = ? ORDER BY o.delivery_date LIMIT 1`)
            .get(req.params.token)?.d;
    }

    try {
        const result = await cachedRepo.addDish({
            token: req.params.token, dishId, mealType, deliveryDate,
        });
        res.status(201).json({
            success: true,
            message: `Added ${result.itemName} to your ${mealType.toLowerCase()} orders`,
            ...result,
        });
    } catch (err) {
        if (err.code === 'DUPLICATE') {
            return res.status(409).json({
                error: 'Dish already exists',
                details: 'This dish is already in your meal plan. Try updating the quantity instead.',
                recordId: err.recordId,
            });
        }
        throw err;
    }
}));

app.patch('/api/orders/:token/quantity', handle(async (req, res) => {
    const { recordId, newQuantity, itemName } = req.body;
    requireRecordId(recordId);

    const quantity = parseInt(newQuantity, 10);
    if (Number.isNaN(quantity) || quantity < 0) {
        return res.status(400).json({ error: 'Invalid quantity value' });
    }

    const order = db.prepare(`SELECT * FROM open_orders WHERE id = ?`).get(recordId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // One row per serving, so quantity changes are row creates/deletes.
    if (quantity === 0) {
        await cachedRepo.removeOrder(recordId);
        return res.json({
            success: true,
            message: `Removed ${itemName || 'item'} from your meal plan`,
            recordId, newQuantity: 0, deleted: true,
        });
    }

    // Order siblings so the row the user is acting on sorts FIRST, then delete
    // from the end. Without this, ties on created_at fall back to the random
    // row id and the decrease can delete the very record the frontend is
    // holding — leaving it with a dead recordId and a card that 404s on the
    // next interaction. The Airtable original had this bug too: its
    // allRecordsForDish.slice(quantity) had no ordering guarantee at all.
    const siblings = db.prepare(
        `SELECT id FROM open_orders
          WHERE client_id = ? AND dish_id = ? AND meal_portion = ? AND delivery_date = ?
          ORDER BY (id = ?) DESC, created_at, id`)
        .all(order.client_id, order.dish_id, order.meal_portion, order.delivery_date, recordId);

    if (quantity > siblings.length) {
        const newRecordIds = await cachedRepo.duplicateOrder(recordId, quantity - siblings.length);
        return res.json({
            success: true,
            message: `Added ${newRecordIds.length} more serving${newRecordIds.length !== 1 ? 's' : ''} of ${itemName}`,
            recordId, newQuantity: quantity,
            newRecordsCreated: newRecordIds.length,
            allRecordIds: [recordId, ...newRecordIds],
            newRecordIds,
        });
    }

    if (quantity < siblings.length) {
        const toDelete = siblings.slice(quantity).map(s => s.id);
        for (const id of toDelete) await cachedRepo.removeOrder(id);
        return res.json({
            success: true,
            message: `Removed ${toDelete.length} serving${toDelete.length !== 1 ? 's' : ''} of ${itemName}`,
            recordId, newQuantity: quantity, recordsDeleted: toDelete.length,
        });
    }

    res.json({ success: true, message: 'No quantity change needed', recordId, newQuantity: quantity });
}));

// ===========================================================================
// OPS
// ===========================================================================

app.get('/api/health', handle(async (req, res) => {
    res.json({
        ok: true,
        db: DB_PATH,
        cacheBackend: backendName,
        cache: { ...cache.stats, hitRate: Number((cache.hitRate() * 100).toFixed(1)) },
        customers: db.prepare(`SELECT COUNT(DISTINCT unique_id) c FROM clients`).get().c,
        orders: db.prepare(`SELECT COUNT(*) c FROM open_orders`).get().c,
    });
}));

app.post('/api/cache/flush', handle(async (req, res) => {
    await cache.invalidatePrefix('');
    res.json({ success: true, message: 'Cache flushed' });
}));

// Endpoints the original had that are not backed here yet. Returning 501
// rather than 404 so it is obvious they were deliberately left, not missed.
app.get('/api/nutrition/:token', (req, res) =>
    res.status(501).json({ error: 'Not implemented — was a stub in the original too' }));
app.post('/api/send-emails', (req, res) =>
    res.status(501).json({ error: 'Not implemented — emailer.js still targets Airtable' }));

app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));

app.listen(PORT, () => {
    const tokens = db.prepare(`SELECT DISTINCT unique_id u FROM clients ORDER BY u`).all();
    console.log(`\n  Square Fare (SQLite) on :${PORT}`);
    console.log(`  db     ${DB_PATH}`);
    console.log(`  cache  ${backendName}`);
    console.log(`  cors   ${CORS_ORIGIN}\n`);
    console.log(`  Open:`);
    for (const t of tokens) console.log(`    http://localhost:3000/meal-plan?customer=${t.u}`);
    console.log();
});
