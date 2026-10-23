/**
 * Single place that opens the database and wires up the repo + cache.
 *
 * Opened once at module load, reused for the process lifetime. better-sqlite3
 * connections are synchronous and cheap to reuse — there is no pool to manage
 * and no per-request connect cost, which is a meaningful part of why the read
 * path is fast.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { SquareFareRepo } = require('./queries');
const { Cache, CachedRepo, MemoryBackend, RedisBackend } = require('./cache');

const DB_PATH = process.env.SQUAREFARE_DB || path.join(__dirname, '..', 'squarefare.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`\n  No database at ${DB_PATH}`);
    console.error(`  Run:  node db/seed.js --force\n`);
    process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Reads dominate this workload and every write is already in a transaction,
// so waiting on fsync for each commit buys durability we do not need locally.
db.pragma('synchronous = NORMAL');

const repo = new SquareFareRepo(db);

// Redis only if REDIS_URL is set, and only if ioredis is actually installed.
// Falls back to in-process rather than crashing, so nobody has to run Redis
// just to develop.
let backend = new MemoryBackend();
let backendName = 'memory';

if (process.env.REDIS_URL) {
    try {
        const Redis = require('ioredis');
        backend = new RedisBackend(new Redis(process.env.REDIS_URL));
        backendName = `redis (${process.env.REDIS_URL})`;
    } catch (err) {
        console.warn(`  REDIS_URL set but ioredis unavailable (${err.message}) — using memory cache.`);
    }
}

const cache = new Cache({ backend });
const cachedRepo = new CachedRepo(repo, cache);

module.exports = { db, repo, cache, cachedRepo, DB_PATH, backendName };
