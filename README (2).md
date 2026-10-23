# Square Fare — local database + cache layer

Replaces the Airtable base with a local SQLite database, so development can
continue without base access. `server.js` and `MealPlanViewer.js` are untouched
in this pass — the new layer runs alongside them so you can diff behaviour
before cutting over.

## Setup

```bash
npm install better-sqlite3
node db/seed.js --force
node bench.js sf-demo-0001
```

Seeded tokens:

| Token | Customer | Notes |
|---|---|---|
| `sf-demo-0001` | Dana Whitfield | Breakfast/Lunch/Dinner/Snack; one order has saved customizations |
| `sf-demo-0002` | Marcus Oyelaran | Lunch/Dinner/Snack, high macros |
| `sf-demo-0003` | Priya Raman | Vegetarian notes, breakfast-heavy |
| `sf-demo-0004` | Elliot Nakashima | Pescatarian, no snacks |
| `sf-demo-0005` | Rosa Delgado | **Subscribed but zero orders** — exercises the early-return branch |

## Files

| File | Purpose |
|---|---|
| `db/schema.sql` | 8 tables + 2 join tables + 1 view |
| `db/seed.js` | Fixture data (real ingredients, synthetic customers) |
| `db/queries.js` | `SquareFareRepo` — data access, fixed query count |
| `db/cache.js` | `Cache` / `CachedRepo` — memory or Redis backend |
| `bench.js` | Measures query count, latency percentiles, invalidation |

## Where the data came from

Ingredient record IDs and component classifications are recovered from
`airtable_output.json`, not invented. Each order's `Final Ingredients` array is
positionally aligned with its `Meal Sticker` string, so the mapping is exact.
`Deletions` / `New Ingredients` fields confirmed the ambiguous ones — an order
that drops `recrXVahIpOSj2xae` has a sticker reading "No Peanut Sesame Sauce",
which pins that ID.

Customer names, addresses, and phone numbers in the export are real. None of
them are carried into the fixture.

## Two things the export disagreed with the code about

**1. `Final Ingredients` vs `Final Ingredients with User Edits`.** The JSON has
the former; `server.js` reads and writes the latter, everywhere. I treated the
code as authoritative and the export as a pre-rename snapshot. If there were
genuinely two separate fields — an immutable snapshot plus a live one — the
schema needs a third `kind` value and the seed needs updating. Worth confirming
if you ever get base access back.

**2. Meal type strings.** The data carries `"Dinner Subscriptions"`,
`"Dinner "` (trailing space), and `"Dinner"` for the same concept.
`MealPlanViewer.js` groups strictly on `['Breakfast','Lunch','Dinner','Snack']`,
so any unnormalised value silently disappears from the UI — a card that exists
in the API response but renders nowhere. `canonicalMeal()` in `queries.js`
normalises at the boundary. This was a live bug class in the original, not
something the migration introduced.

## Why the query layer matters more than the cache

The Airtable `GET /api/orders/:token` issues roughly 70–80 network round trips
for a single page load:

- 1 client, 1 orders, 1 weekly menu
- **1 per menu item** for its ingredients (`getAvailableDishes` loops)
- **1 per protein option** to resolve its name (`getProteinOptionsForOrder` loops)
- 1 per `getIngredientName()` call

`CACHED_VARIANTS` and `CACHED_STANDARD_SAUCES` cut the worst of it, which is
where the 77s → 59s win came from. But caching around an N+1 doesn't remove the
N+1 — the work is still `O(dishes × ingredients)` in round trips, and the p95
stays bad whenever the cache is cold or the menu changes.

In SQL those loops become joins. Measured on the seeded fixture:

```
QUERY COUNT (per full page load)
  SQLite repo                  7
  Airtable equivalent          ~70 network round trips

LATENCY
  repo, no cache               p50    2.08ms   p95   10.83ms   p99   17.40ms
  repo + cache (warm)          p50   0.002ms   p95   0.003ms   p99   0.015ms
```

The count is fixed at 7 regardless of how many dishes, ingredients, or orders
are involved. That's the structural win. The cache then sits on an already-fast
path instead of hiding a slow one.

Note the SQLite numbers are local-disk and will not survive a move to networked
Postgres unchanged — but the *query count* will, and that's the number that
predicts behaviour under real network latency.

## Cache design

The original used four module-level globals with three different policies:
`CACHED_VARIANTS` had a 5-minute TTL, `CACHED_STANDARD_SAUCES` cached forever,
`CACHED_INGREDIENT_COMPONENTS` cached forever **and never invalidated** — change
an ingredient's component and the running server serves the stale value until
restart.

`db/cache.js` consolidates this into one async interface:

- **Explicit TTLs** in one `TTL` object rather than scattered constants
- **Explicit invalidation** — `CachedRepo` busts the affected customer's plan on
  every write, so a customer never sees the meal they just deleted
- **Stampede protection** — concurrent misses on the same key share one loader
  instead of all running it
- **Swappable backend** — `MemoryBackend` by default, `RedisBackend` takes any
  ioredis-compatible client

Going to Redis:

```js
const Redis = require('ioredis');
const { Cache, CachedRepo, RedisBackend } = require('./db/cache');

const cache = new Cache({ backend: new RedisBackend(new Redis(process.env.REDIS_URL)) });
const repo  = new CachedRepo(new SquareFareRepo(db), cache);
```

Nothing else changes — the interface was already async and string-keyed.

`delPrefix` uses `SCAN`, not `KEYS`. `KEYS` blocks the Redis event loop for the
duration of the scan, which on a large keyspace is exactly the stall this is
meant to remove.

## Other things worth fixing while you're in here

**Transactions.** The Airtable writes update `Final Ingredients` and
`Customer Edits` in one call but can't roll back across calls — a failure
partway through leaves an order in a state the UI can't explain. Every write in
`queries.js` is a single transaction.

**SQL injection surface.** `server.js` interpolates the token directly into
`filterByFormula` strings. Airtable formulas aren't SQL so this isn't classic
injection, but a token containing a quote breaks the query, and a crafted one
could widen the filter to return other customers' orders. Every statement in
`queries.js` is parameterised.

**A real bug in the current code.** In the `PATCH /api/orders/:token/ingredients`
handler, the `Customer Edits` string references `ingredientName` and
`shouldActivate` — neither is defined in that scope. That endpoint throws a
`ReferenceError` on the write. `MealPlanViewer.js` doesn't call it (it uses
`/ingredients/toggle`), so it's dead code, but it will bite whoever wires it up.

**Quantity modelling.** One row per serving means "set quantity to 3" is a
create-two-rows operation and "set to 1" is a delete-two-rows operation, with
the frontend reconciling temporary IDs afterward — hence the `isTemporary` flag
and `flushSync` calls in `MealPlanViewer.js`. A `quantity` column on a single
row would delete a lot of that complexity on both sides. Bigger change than this
pass, but it's the next real simplification.

## Cutting `server.js` over

Per endpoint:

| Current | Replacement |
|---|---|
| `GET /api/orders/:token` | `repo.getMealPlan(token)` |
| `PATCH .../replace-protein` | `repo.replaceComponent(id, 'Meat', newId, { upgradePrice })` |
| `PATCH .../replace-sauce` | `repo.replaceComponent(id, 'Sauce', newId)` |
| `PATCH .../toggle-starch` | `repo.replaceComponent(id, 'Starch', starchId)` |
| `PATCH .../toggle-veggie` | `repo.toggleIngredient(id, veggieId, activate)` |
| `PATCH .../toggle-garnish` | `repo.toggleIngredient(id, garnishId, activate)` |
| `POST .../add-dish` | `repo.addDish({ token, dishId, mealType, deliveryDate })` |
| `PATCH .../quantity` (to 0) | `repo.removeOrder(id)` |
| `PATCH .../quantity` (increase) | `repo.duplicateOrder(id, delta)` |

Response shapes are unchanged, so the frontend needs no edits.

## Known rough edge

`bench.js` mutates the database to prove invalidation works. Re-run
`node db/seed.js --force` afterward if you want a clean fixture.

---

# Running it against the frontend

```bash
npm install better-sqlite3 express
node db/seed.js --force
node server.sqlite.js          # port 3001, same as the original
```

Then start the React app as usual and open
`http://localhost:3000/?customer=sf-demo-0001`.

`server.js` is left on disk, untouched and unused. It stays as the reference
for what the Airtable behaviour was — the only surviving documentation of a
system that can no longer be queried. Don't delete it until every UI
interaction has been exercised against the new server.

## Testing

```bash
node e2e.js          # 60 assertions over real HTTP — needs the server running
node bench.js        # query count + latency percentiles
node concurrency.js  # parallel reads, cache stampede, scaling
```

`e2e.js` asserts response *shapes*, not just status codes. A route that returns
200 with the wrong field names still breaks the UI silently, because React
renders `undefined` as nothing.

## A bug the e2e test caught

The quantity-decrease path deletes sibling rows from the end of an ordered list.
Rows created by `add-dish` and `duplicate` land in the same second, so
`created_at` ties and ordering falls back to the row id — which is random. The
row the user is actually acting on could sort last and get deleted, leaving the
frontend holding a dead `recordId` and a card that 404s on the next click.

Fixed by sorting the acted-on row first: `ORDER BY (id = ?) DESC, created_at, id`.

**The original `server.js` has this same bug** — `allRecordsForDish.slice(quantity)`
has no ordering guarantee whatsoever. It would surface as "I reduced from 3 to 1
and then couldn't edit the remaining one," intermittently, depending on the
order Airtable happened to return records in.

## Endpoints deliberately not ported

| Route | Status |
|---|---|
| `GET /api/nutrition/:token` | 501 — was a stub in the original too |
| `POST /api/send-emails` | 501 — `emailer.js` still targets Airtable |

They return 501 rather than 404 so it's obvious they were left on purpose.

## Ops endpoints (new)

| Route | Purpose |
|---|---|
| `GET /api/health` | db path, cache backend, hit rate, row counts |
| `POST /api/cache/flush` | clear the cache without restarting |
