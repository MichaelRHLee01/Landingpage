/**
 * Square Fare — end-to-end HTTP test
 *
 * Exercises every route MealPlanViewer.js actually calls, over real HTTP,
 * against a running server.sqlite.js. This is the layer bench.js and
 * concurrency.js skip: they require() the repo directly, so they prove the
 * data layer works but say nothing about whether the browser can reach it.
 *
 * Each test asserts the RESPONSE SHAPE the frontend destructures, not just a
 * 200. A route returning 200 with the wrong field names still breaks the UI —
 * silently, because React renders undefined as nothing.
 *
 * Usage:  node server.sqlite.js &   then   node e2e.js
 */

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const TOKEN = process.argv[2] || 'sf-demo-0001';

let pass = 0, fail = 0;

function check(name, condition, detail = '') {
    if (condition) { pass += 1; console.log(`  PASS  ${name}`); }
    else { fail += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

async function req(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {
    console.log(`\nAPI: ${BASE}`);
    console.log(`Token: ${TOKEN}\n`);

    // -----------------------------------------------------------------
    console.log('GET /orders/:token');
    const plan = await req('GET', `/orders/${TOKEN}`);
    check('200', plan.status === 200, `got ${plan.status}`);

    const d = plan.body;
    check('customer.name present', typeof d?.customer?.name === 'string');
    check('customer.email present', typeof d?.customer?.email === 'string');
    check('orders is array', Array.isArray(d?.orders));
    check('subscriptions is array', Array.isArray(d?.subscriptions));
    check('nutritionGoals present', d?.nutritionGoals != null);

    const ordered = d.orders.filter(o => o.quantity > 0);
    const available = d.orders.filter(o => o.quantity === 0);
    check('has ordered dishes', ordered.length > 0, `${ordered.length}`);
    check('has available dishes', available.length > 0, `${available.length}`);

    // Fields MealPlanViewer destructures on every card.
    const card = ordered[0];
    for (const f of ['recordId', 'dishId', 'itemName', 'quantity', 'deliveryDate',
                     'meal', 'ingredients', 'allIngredients', 'sauceOptions',
                     'garnishOptions', 'veggieOptions', 'starchOptions',
                     'proteinOptions', 'hasCustomIngredients']) {
        check(`card.${f} present`, card[f] !== undefined);
    }
    check('proteinOptions.options is array', Array.isArray(card.proteinOptions?.options));

    // The frontend groups strictly on these four; anything else vanishes.
    const meals = [...new Set(d.orders.map(o => o.meal))];
    check('meal values canonical',
        meals.every(m => ['Breakfast', 'Lunch', 'Dinner', 'Snack'].includes(m)),
        meals.join(','));

    const dates = [...new Set(d.orders.map(o => o.deliveryDate))];
    check('delivery dates present', dates.length > 0, dates.join(', '));

    // -----------------------------------------------------------------
    console.log('\nPATCH /orders/:token/toggle-veggie');
    const veggieCard = ordered.find(o => o.veggieOptions?.some(v => v.isActive));
    if (veggieCard) {
        const v = veggieCard.veggieOptions.find(x => x.isActive);
        const off = await req('PATCH', `/orders/${TOKEN}/toggle-veggie`,
            { recordId: veggieCard.recordId, veggieId: v.id, shouldActivate: false });
        check('200', off.status === 200, `got ${off.status}`);
        check('updatedIngredientIds returned', Array.isArray(off.body?.updatedIngredientIds));
        check('veggie actually removed', !off.body.updatedIngredientIds.includes(v.id));

        const on = await req('PATCH', `/orders/${TOKEN}/toggle-veggie`,
            { recordId: veggieCard.recordId, veggieId: v.id, shouldActivate: true });
        check('re-add works', on.body?.updatedIngredientIds?.includes(v.id));
    } else { check('veggie card available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nPATCH /orders/:token/toggle-garnish');
    const garnishCard = ordered.find(o => o.garnishOptions?.length);
    if (garnishCard) {
        const g = garnishCard.garnishOptions[0];
        const r = await req('PATCH', `/orders/${TOKEN}/toggle-garnish`,
            { recordId: garnishCard.recordId, garnishId: g.id, shouldActivate: false });
        check('200', r.status === 200, `got ${r.status}`);
        check('garnish removed', !r.body?.updatedIngredientIds?.includes(g.id));
    } else { check('garnish card available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nPATCH /orders/:token/replace-protein');
    const proteinCard = ordered.find(o => o.proteinOptions?.options?.length > 1);
    if (proteinCard) {
        const cur = proteinCard.proteinOptions.options.find(o => o.isActive);
        const next = proteinCard.proteinOptions.options.find(o => !o.isActive);
        const r = await req('PATCH', `/orders/${TOKEN}/replace-protein`, {
            recordId: proteinCard.recordId,
            newProteinId: next.id, oldProteinId: cur?.id, upgradePrice: next.price || 0,
        });
        check('200', r.status === 200, `got ${r.status}`);
        check('updatedIngredientIds returned', Array.isArray(r.body?.updatedIngredientIds));
        check('new protein present', r.body.updatedIngredientIds.includes(next.id));
        check('old protein gone', !cur || !r.body.updatedIngredientIds.includes(cur.id));

        // The premium-upgrade path the price-confirmation modal depends on.
        const premium = proteinCard.proteinOptions.options.find(o => o.price > 0);
        if (premium) {
            const up = await req('PATCH', `/orders/${TOKEN}/replace-protein`, {
                recordId: proteinCard.recordId, newProteinId: premium.id,
                oldProteinId: next.id, upgradePrice: premium.price,
            });
            check('premium upgrade echoes price', up.body?.upgradePrice === premium.price,
                `${up.body?.upgradePrice} vs ${premium.price}`);
            check('premium message mentions $', /\$/.test(up.body?.message || ''));
        }
    } else { check('protein card available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nPATCH /orders/:token/replace-sauce');
    const sauceCard = ordered.find(o => o.sauceOptions?.length > 1);
    if (sauceCard) {
        const target = sauceCard.sauceOptions.find(s => s.id && !s.isActive);
        const r = await req('PATCH', `/orders/${TOKEN}/replace-sauce`,
            { recordId: sauceCard.recordId, newSauceId: target.id, oldSauceId: null });
        check('200', r.status === 200, `got ${r.status}`);
        check('new sauce present', r.body?.updatedIngredientIds?.includes(target.id));

        // "No Sauce" sends null — a real edge case the original handled.
        const none = await req('PATCH', `/orders/${TOKEN}/replace-sauce`,
            { recordId: sauceCard.recordId, newSauceId: null, oldSauceId: target.id });
        check('No Sauce (null id) accepted', none.status === 200, `got ${none.status}`);
        check('sauce actually cleared', !none.body?.updatedIngredientIds?.includes(target.id));
    } else { check('sauce card available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nPATCH /orders/:token/toggle-starch');
    const starchCard = ordered.find(o => o.starchOptions?.length > 1);
    if (starchCard) {
        const target = starchCard.starchOptions.find(s => !s.isActive);
        const r = await req('PATCH', `/orders/${TOKEN}/toggle-starch`,
            { recordId: starchCard.recordId, starchId: target.id, shouldActivate: true });
        check('200', r.status === 200, `got ${r.status}`);
        check('new starch present', r.body?.updatedIngredientIds?.includes(target.id));

        // Replace-only: exactly one starch should remain.
        const after = await req('GET', `/orders/${TOKEN}`);
        const updated = after.body.orders.find(o => o.recordId === starchCard.recordId);
        const activeStarches = updated.starchOptions.filter(s => s.isActive).length;
        check('exactly one starch active', activeStarches === 1, `${activeStarches}`);
    } else { check('starch card available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nPOST /orders/:token/add-dish');
    const fresh = await req('GET', `/orders/${TOKEN}`);
    const addable = fresh.body.orders.find(o => o.quantity === 0);
    if (addable) {
        const r = await req('POST', `/orders/${TOKEN}/add-dish`, {
            dishId: addable.dishId, mealType: addable.meal,
            requestedDeliveryDate: addable.deliveryDate,
        });
        check('201', r.status === 201, `got ${r.status}`);
        check('recordId returned', typeof r.body?.recordId === 'string');

        const dupe = await req('POST', `/orders/${TOKEN}/add-dish`, {
            dishId: addable.dishId, mealType: addable.meal,
            requestedDeliveryDate: addable.deliveryDate,
        });
        check('duplicate returns 409', dupe.status === 409, `got ${dupe.status}`);

        // ---- quantity round trip on the dish we just added ----
        console.log('\nPATCH /orders/:token/quantity');
        const up = await req('PATCH', `/orders/${TOKEN}/quantity`,
            { recordId: r.body.recordId, newQuantity: 3, itemName: addable.itemName });
        check('increase 200', up.status === 200, `got ${up.status}`);
        check('newRecordIds returned', Array.isArray(up.body?.newRecordIds));
        check('created 2 new rows', up.body?.newRecordIds?.length === 2,
            `${up.body?.newRecordIds?.length}`);

        const down = await req('PATCH', `/orders/${TOKEN}/quantity`,
            { recordId: r.body.recordId, newQuantity: 1, itemName: addable.itemName });
        check('decrease 200', down.status === 200, `got ${down.status}`);
        check('deleted 2 rows', down.body?.recordsDeleted === 2, `${down.body?.recordsDeleted}`);

        const zero = await req('PATCH', `/orders/${TOKEN}/quantity`,
            { recordId: r.body.recordId, newQuantity: 0, itemName: addable.itemName });
        check('remove 200', zero.status === 200, `got ${zero.status}`);
        check('deleted flag set', zero.body?.deleted === true);
    } else { check('addable dish available', false, 'none found'); }

    // -----------------------------------------------------------------
    console.log('\nError handling');
    const missing = await req('GET', '/orders/does-not-exist');
    check('unknown token 404', missing.status === 404, `got ${missing.status}`);

    const nullRec = await req('PATCH', `/orders/${TOKEN}/toggle-veggie`,
        { recordId: null, veggieId: 'x', shouldActivate: true });
    check('null recordId 400', nullRec.status === 400, `got ${nullRec.status}`);

    const badRoute = await req('GET', '/nope');
    check('unknown route 404', badRoute.status === 404, `got ${badRoute.status}`);

    const empty = await req('GET', '/orders/sf-demo-0005');
    check('zero-order customer 200', empty.status === 200, `got ${empty.status}`);
    check('zero-order returns available dishes',
        empty.body?.orders?.length > 0, `${empty.body?.orders?.length}`);
    check('zero-order has no ordered dishes',
        empty.body?.orders?.every(o => o.quantity === 0));

    // -----------------------------------------------------------------
    console.log('\nCache invalidation over HTTP');
    const before = await req('GET', `/orders/${TOKEN}`);
    const target2 = before.body.orders.find(o => o.quantity > 0 && o.garnishOptions?.some(g => g.isActive));
    if (target2) {
        const g = target2.garnishOptions.find(x => x.isActive);
        const n1 = before.body.orders.find(o => o.recordId === target2.recordId).ingredients.length;
        await req('PATCH', `/orders/${TOKEN}/toggle-garnish`,
            { recordId: target2.recordId, garnishId: g.id, shouldActivate: false });
        const after2 = await req('GET', `/orders/${TOKEN}`);
        const n2 = after2.body.orders.find(o => o.recordId === target2.recordId).ingredients.length;
        check('write visible on next GET', n2 === n1 - 1, `${n1} -> ${n2}`);
    }

    const health = await req('GET', '/health');
    check('health 200', health.status === 200);
    console.log(`\n  cache hit rate ${health.body?.cache?.hitRate}%  backend ${health.body?.cacheBackend}`);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
