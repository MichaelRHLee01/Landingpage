/**
 * Measures the actual read path so the latency claims here are numbers,
 * not assertions. Counts queries as well as wall time — query count is the
 * number that predicts how this behaves under a real network.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { SquareFareRepo } = require('./db/queries');
const { Cache, CachedRepo } = require('./db/cache');

const DB = path.join(__dirname, 'squarefare.db');
const TOKEN = process.argv[2] || 'sf-demo-0001';

const db = new Database(DB, { readonly: false });

// Count every statement the repo actually executes.
let queryCount = 0;
const origPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    for (const m of ['all', 'get', 'run']) {
        const orig = stmt[m].bind(stmt);
        stmt[m] = (...args) => { queryCount += 1; return orig(...args); };
    }
    return stmt;
};

const repo = new SquareFareRepo(db);

function timed(label, fn, iterations = 200) {
    fn(); // warm
    const samples = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.floor(samples.length * q)].toFixed(2);
    console.log(`  ${label.padEnd(28)} p50 ${p(0.5).padStart(7)}ms   `
        + `p95 ${p(0.95).padStart(7)}ms   p99 ${p(0.99).padStart(7)}ms`);
    return samples;
}

(async () => {
    console.log(`\nToken: ${TOKEN}\n`);

    queryCount = 0;
    const plan = repo.getMealPlan(TOKEN);
    const cold = queryCount;

    if (!plan) { console.error('No such token.'); process.exit(1); }

    console.log('SHAPE');
    console.log(`  customer                     ${plan.customer.name}`);
    console.log(`  cards returned               ${plan.orders.length}`);
    console.log(`  ordered                      ${plan.orders.filter(o => o.quantity > 0).length}`);
    console.log(`  available                    ${plan.orders.filter(o => o.quantity === 0).length}`);
    console.log(`  delivery dates               ${[...new Set(plan.orders.map(o => o.deliveryDate))].join(', ')}`);
    console.log(`  subscriptions                ${plan.subscriptions.length}`);

    console.log('\nQUERY COUNT (per full page load)');
    console.log(`  SQLite repo                  ${cold}`);
    console.log(`  Airtable equivalent          ~${estimateAirtableCalls(plan)} network round trips`);

    console.log('\nLATENCY');
    timed('repo, no cache', () => repo.getMealPlan(TOKEN));

    const cached = new CachedRepo(repo, new Cache());
    await cached.getMealPlan(TOKEN);

    const samples = [];
    for (let i = 0; i < 200; i++) {
        const t0 = process.hrtime.bigint();
        await cached.getMealPlan(TOKEN);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.floor(samples.length * q)].toFixed(3);
    console.log(`  ${'repo + cache (warm)'.padEnd(28)} p50 ${p(0.5).padStart(7)}ms   `
        + `p95 ${p(0.95).padStart(7)}ms   p99 ${p(0.99).padStart(7)}ms`);

    console.log(`\n  cache hit rate               ${(cached.cache.hitRate() * 100).toFixed(1)}%`);

    // Prove invalidation actually works rather than assuming it.
    const target = plan.orders.find(o => o.quantity > 0 && o.garnishOptions.length);
    if (target) {
        const g = target.garnishOptions[0];
        const before = (await cached.getMealPlan(TOKEN))
            .orders.find(o => o.recordId === target.recordId).ingredients.length;
        await cached.toggleIngredient(target.recordId, g.id, false);
        const after = (await cached.getMealPlan(TOKEN))
            .orders.find(o => o.recordId === target.recordId).ingredients.length;
        console.log(`\nINVALIDATION`);
        console.log(`  removed "${g.name}" from ${target.itemName}`);
        console.log(`  ingredients ${before} -> ${after}   ${after === before - 1 ? 'PASS' : 'FAIL'}`);
    }

    console.log();
    db.close();
})();

/**
 * Reconstructs the round-trip count the Airtable implementation would make
 * for this same payload, following the call sites in server.js.
 */
function estimateAirtableCalls(plan) {
    const ordered = plan.orders.filter(o => o.quantity > 0);
    const available = plan.orders.filter(o => o.quantity === 0);
    const uniqueAvailable = new Set(available.map(o => `${o.dishId}:${o.meal}`)).size;
    const proteinGroups = new Set(
        plan.orders.map(o => o.proteinOptions?.currentProtein?.id).filter(Boolean));
    const proteinOptionLookups = [...proteinGroups]
        .reduce((n, id) => n + (plan.orders.find(
            o => o.proteinOptions?.currentProtein?.id === id)?.proteinOptions.options.length || 0), 0);

    return 1                      // client
        + 1                       // orders
        + 1                       // weekly menu
        + uniqueAvailable         // one Dishes query per menu item
        + 1                       // batched ingredient fetch
        + 1                       // variants
        + 1                       // standard sauces
        + 1                       // images
        + 1                       // subscriptions
        + proteinOptionLookups    // one ingredient fetch per protein option
        + ordered.length * 0;     // (option sets were cached by key)
}
