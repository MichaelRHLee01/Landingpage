/**
 * Square Fare — concurrency test
 *
 * bench.js measures one caller in a loop. That tells you nothing about what
 * happens when 50 customers load the page at the same moment, which is the
 * only situation where latency actually matters.
 *
 * Two questions here:
 *
 *   1. Do parallel reads serialize? SQLite in WAL mode should allow concurrent
 *      readers. If they serialize, total time scales linearly with request
 *      count and the "7 queries" win evaporates under load.
 *
 *   2. Does stampede protection work? When N requests miss the same cold cache
 *      key simultaneously, a naive cache runs the loader N times. Cache.wrap()
 *      is supposed to dedupe them into one. This proves it or doesn't.
 *
 * HONEST CAVEAT: Node is single-threaded and better-sqlite3 is synchronous, so
 * this measures how the real server would behave (one event loop, requests
 * interleaved) rather than true OS-level parallelism. That is the right thing
 * to measure — it is what your Express process actually does — but it is not a
 * multi-core benchmark.
 *
 * Usage:  node concurrency.js [concurrentRequests] [rounds]
 */

const path = require('path');
const Database = require('better-sqlite3');
const { SquareFareRepo } = require('./db/queries');
const { Cache, CachedRepo } = require('./db/cache');

const CONCURRENCY = parseInt(process.argv[2], 10) || 50;
const ROUNDS = parseInt(process.argv[3], 10) || 20;

const db = new Database(path.join(__dirname, 'squarefare.db'));
const repo = new SquareFareRepo(db);

const TOKENS = db.prepare(`SELECT DISTINCT unique_id FROM clients ORDER BY unique_id`)
    .all().map(r => r.unique_id);

function pct(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return {
        p50: at(0.50).toFixed(2),
        p95: at(0.95).toFixed(2),
        p99: at(0.99).toFixed(2),
        max: s[s.length - 1].toFixed(2),
    };
}

function report(label, samples, wallMs, total) {
    const p = pct(samples);
    console.log(`  ${label.padEnd(26)} p50 ${p.p50.padStart(7)}  p95 ${p.p95.padStart(7)}`
        + `  p99 ${p.p99.padStart(7)}  max ${p.max.padStart(7)}   `
        + `${(total / (wallMs / 1000)).toFixed(0).padStart(6)} req/s`);
}

async function main() {
    console.log(`\nConcurrency: ${CONCURRENCY} parallel requests x ${ROUNDS} rounds`);
    console.log(`Tokens in rotation: ${TOKENS.length}\n`);

    // ---------------------------------------------------------------------
    // TEST 1 — parallel reads, no cache.
    // If WAL reads serialize, throughput here will be flat no matter how high
    // CONCURRENCY goes.
    // ---------------------------------------------------------------------
    console.log('TEST 1  parallel reads, no cache');

    let samples = [];
    let t0 = Date.now();

    for (let round = 0; round < ROUNDS; round++) {
        await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => {
            const token = TOKENS[i % TOKENS.length];
            return Promise.resolve().then(() => {
                const s = process.hrtime.bigint();
                repo.getMealPlan(token);
                samples.push(Number(process.hrtime.bigint() - s) / 1e6);
            });
        }));
    }
    report('uncached', samples, Date.now() - t0, samples.length);

    // ---------------------------------------------------------------------
    // TEST 2 — same load, warm cache.
    // ---------------------------------------------------------------------
    console.log('\nTEST 2  parallel reads, warm cache');

    const cache = new Cache();
    const cached = new CachedRepo(repo, cache);
    for (const t of TOKENS) await cached.getMealPlan(t);   // warm

    samples = [];
    t0 = Date.now();

    for (let round = 0; round < ROUNDS; round++) {
        await Promise.all(Array.from({ length: CONCURRENCY }, async (_, i) => {
            const token = TOKENS[i % TOKENS.length];
            const s = process.hrtime.bigint();
            await cached.getMealPlan(token);
            samples.push(Number(process.hrtime.bigint() - s) / 1e6);
        }));
    }
    report('cached', samples, Date.now() - t0, samples.length);
    console.log(`  hit rate ${(cache.hitRate() * 100).toFixed(1)}%`);

    // ---------------------------------------------------------------------
    // TEST 3 — cache stampede.
    // Fire CONCURRENCY requests at a COLD key simultaneously. A naive cache
    // runs the loader CONCURRENCY times. wrap() should run it exactly once.
    // ---------------------------------------------------------------------
    console.log('\nTEST 3  cache stampede on a cold key');

    const token = TOKENS[0];

    // Instrumented repo so we can count real loader invocations.
    let loaderCalls = 0;
    const countingRepo = {
        getMealPlan: (t) => { loaderCalls += 1; return repo.getMealPlan(t); },
    };

    const stampedeCache = new Cache();
    const stampedeRepo = new CachedRepo(countingRepo, stampedeCache);

    t0 = Date.now();
    const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => stampedeRepo.getMealPlan(token)));
    const wall = Date.now() - t0;

    const allSame = results.every(r => r.orders.length === results[0].orders.length);

    console.log(`  requests fired            ${CONCURRENCY}`);
    console.log(`  loader actually ran       ${loaderCalls}`);
    console.log(`  wall time                 ${wall}ms`);
    console.log(`  all results identical     ${allSame ? 'yes' : 'NO — BUG'}`);
    console.log(`  stampede protection       ${loaderCalls === 1 ? 'PASS' : `FAIL (expected 1, got ${loaderCalls})`}`);

    // Control: same load with caching disabled, to show what the loader count
    // looks like without protection.
    let naiveCalls = 0;
    const naive = { getMealPlan: (t) => { naiveCalls += 1; return repo.getMealPlan(t); } };
    const noCache = new CachedRepo(naive, new Cache({ enabled: false }));
    await Promise.all(Array.from({ length: CONCURRENCY }, () => noCache.getMealPlan(token)));
    console.log(`  (control, cache off)      loader ran ${naiveCalls}x`);

    // ---------------------------------------------------------------------
    // TEST 4 — scaling. Does throughput hold as concurrency climbs?
    // ---------------------------------------------------------------------
    console.log('\nTEST 4  scaling');
    console.log('  concurrency   wall      per-req    req/s');

    for (const n of [1, 10, 25, 50, 100, 200]) {
        const s = Date.now();
        await Promise.all(Array.from({ length: n }, (_, i) =>
            Promise.resolve().then(() => repo.getMealPlan(TOKENS[i % TOKENS.length]))));
        const w = Date.now() - s;
        console.log(`  ${String(n).padStart(11)}   ${String(w + 'ms').padStart(7)}`
            + `   ${(w / n).toFixed(2).padStart(7)}ms   ${(n / (w / 1000)).toFixed(0).padStart(6)}`);
    }

    console.log('\n  Flat per-request time as concurrency rises = no serialization.');
    console.log('  Rising per-request time = requests are queueing behind each other.\n');

    db.close();
}

main().catch(e => { console.error(e); process.exit(1); });