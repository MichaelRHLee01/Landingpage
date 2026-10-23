/**
 * Square Fare — cache layer
 *
 * DESIGN INTENT
 *
 * The Airtable version cached with module-level globals: CACHED_STANDARD_SAUCES,
 * CACHED_VARIANTS, CACHED_INGREDIENT_COMPONENTS, CACHE_TIMESTAMP. Those work,
 * but they have three problems that matter once there is more than one process:
 *
 *   1. Per-process. Two Node instances = two cold caches, no sharing.
 *   2. No invalidation. CACHED_INGREDIENT_COMPONENTS never expires at all —
 *      change an ingredient's component in Airtable and the running server
 *      keeps the stale value until restart.
 *   3. Mixed policies. Variants use a 5-minute TTL, sauces cache forever,
 *      components cache forever. Three different behaviours, no single place
 *      to reason about correctness.
 *
 * This module presents ONE async interface with explicit TTLs and explicit
 * invalidation. The default backend is in-process (no infra needed to develop);
 * swapping to Redis is a constructor argument, not a rewrite, because the
 * interface is already async and already string-keyed.
 *
 * IMPORTANT: caching is the second lever, not the first. queries.js already
 * removed the N+1 round trips. This layer exists to avoid recomputing option
 * sets, not to hide slow I/O.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** In-process backend. Fine for single-instance dev and single-instance prod. */
class MemoryBackend {
    constructor() { this.store = new Map(); }

    async get(key) {
        const hit = this.store.get(key);
        if (!hit) return undefined;
        if (hit.expires && hit.expires < Date.now()) { this.store.delete(key); return undefined; }
        return hit.value;
    }

    async set(key, value, ttlMs) {
        this.store.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
    }

    async del(key) { this.store.delete(key); }

    async delPrefix(prefix) {
        for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
    }

    async clear() { this.store.clear(); }
}

/**
 * Redis backend. Takes any ioredis-compatible client so this file has no
 * hard dependency — nothing to install until you actually want Redis.
 *
 *   const Redis = require('ioredis');
 *   const cache = new Cache({ backend: new RedisBackend(new Redis(process.env.REDIS_URL)) });
 *
 * Note on delPrefix: SCAN, not KEYS. KEYS blocks the Redis event loop for the
 * duration of the scan, which on a large keyspace is exactly the kind of
 * stall this whole exercise is trying to remove.
 */
class RedisBackend {
    constructor(client, namespace = 'sf') {
        this.client = client;
        this.ns = namespace;
    }

    _k(key) { return `${this.ns}:${key}`; }

    async get(key) {
        const raw = await this.client.get(this._k(key));
        if (raw === null || raw === undefined) return undefined;
        try { return JSON.parse(raw); } catch { return undefined; }
    }

    async set(key, value, ttlMs) {
        const raw = JSON.stringify(value);
        if (ttlMs) await this.client.set(this._k(key), raw, 'PX', ttlMs);
        else await this.client.set(this._k(key), raw);
    }

    async del(key) { await this.client.del(this._k(key)); }

    async delPrefix(prefix) {
        const match = `${this.ns}:${prefix}*`;
        let cursor = '0';
        do {
            const [next, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 200);
            cursor = next;
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== '0');
    }

    async clear() { await this.delPrefix(''); }
}

class Cache {
    constructor({ backend = new MemoryBackend(), defaultTtlMs = DEFAULT_TTL_MS, enabled = true } = {}) {
        this.backend = backend;
        this.defaultTtlMs = defaultTtlMs;
        this.enabled = enabled;
        this.stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };
        // Dedupes concurrent misses for the same key. Without this, N simultaneous
        // requests for a cold key all run the loader — the classic stampede.
        this.inflight = new Map();
    }

    async get(key) {
        if (!this.enabled) return undefined;
        const v = await this.backend.get(key);
        if (v === undefined) this.stats.misses += 1; else this.stats.hits += 1;
        return v;
    }

    async set(key, value, ttlMs = this.defaultTtlMs) {
        if (!this.enabled) return;
        this.stats.sets += 1;
        await this.backend.set(key, value, ttlMs);
    }

    /** Read-through with stampede protection. */
    async wrap(key, loader, ttlMs = this.defaultTtlMs) {
        if (!this.enabled) return loader();

        const cached = await this.get(key);
        if (cached !== undefined) return cached;

        if (this.inflight.has(key)) return this.inflight.get(key);

        const p = (async () => {
            try {
                const value = await loader();
                await this.set(key, value, ttlMs);
                return value;
            } finally {
                this.inflight.delete(key);
            }
        })();

        this.inflight.set(key, p);
        return p;
    }

    async invalidate(key) {
        this.stats.invalidations += 1;
        await this.backend.del(key);
    }

    async invalidatePrefix(prefix) {
        this.stats.invalidations += 1;
        await this.backend.delPrefix(prefix);
    }

    hitRate() {
        const total = this.stats.hits + this.stats.misses;
        return total === 0 ? 0 : this.stats.hits / total;
    }
}

/**
 * Key builders. Centralised so invalidation can be reasoned about — if you
 * are ever unsure what a write should bust, the answer is in this object.
 */
const keys = {
    mealPlan: (token) => `mealplan:${token}`,
    mealPlanPrefix: (token) => `mealplan:${token}`,
    reference: () => 'ref:v1',
    menu: () => 'menu:active',
};

/**
 * TTL policy, in one place.
 *
 * Reference data (variants, sauce codes, ingredient components) changes when
 * ops edits the base — rare, and a few minutes of staleness is harmless.
 *
 * Meal plans change on every customer click. The TTL here is short and is
 * really a safety net; the real correctness mechanism is explicit
 * invalidation on write. A long TTL with no invalidation is how you end up
 * serving a customer the meal they just deleted.
 */
const TTL = {
    reference: 10 * 60 * 1000,
    menu: 5 * 60 * 1000,
    mealPlan: 60 * 1000,
};

/**
 * Wraps a SquareFareRepo so reads go through cache and writes bust it.
 * Every mutating method invalidates the affected customer's plan before
 * returning, so a write is never visible as stale on the next read.
 */
class CachedRepo {
    constructor(repo, cache = new Cache()) {
        this.repo = repo;
        this.cache = cache;
    }

    async getMealPlan(token) {
        return this.cache.wrap(keys.mealPlan(token),
            () => this.repo.getMealPlan(token), TTL.mealPlan);
    }

    /** Resolve which customer an order belongs to, so writes know what to bust. */
    _tokenForOrder(orderId) {
        return this.repo.db.prepare(
            `SELECT c.unique_id FROM open_orders o
               JOIN clients c ON c.id = o.client_id
              WHERE o.id = ?`).get(orderId)?.unique_id;
    }

    async toggleIngredient(orderId, ingredientId, shouldActivate) {
        const token = this._tokenForOrder(orderId);
        const result = this.repo.toggleIngredient(orderId, ingredientId, shouldActivate);
        if (token) await this.cache.invalidate(keys.mealPlan(token));
        return result;
    }

    async replaceComponent(orderId, component, newIngredientId, opts) {
        const token = this._tokenForOrder(orderId);
        const result = this.repo.replaceComponent(orderId, component, newIngredientId, opts);
        if (token) await this.cache.invalidate(keys.mealPlan(token));
        return result;
    }

    async addDish(args) {
        const result = this.repo.addDish(args);
        await this.cache.invalidate(keys.mealPlan(args.token));
        return result;
    }

    async removeOrder(orderId) {
        const token = this._tokenForOrder(orderId);
        this.repo.removeOrder(orderId);
        if (token) await this.cache.invalidate(keys.mealPlan(token));
    }

    async duplicateOrder(orderId, times) {
        const token = this._tokenForOrder(orderId);
        const ids = this.repo.duplicateOrder(orderId, times);
        if (token) await this.cache.invalidate(keys.mealPlan(token));
        return ids;
    }
}

module.exports = { Cache, CachedRepo, MemoryBackend, RedisBackend, keys, TTL };
