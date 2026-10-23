# Square Fare — What Changed

A complete record of this project's rebuild, written so you can follow it
without re-deriving the reasoning later.

---

## The situation at the start

You had two source files from your Square Fare internship — `server.js` and
`MealPlanViewer.js` — plus a JSON export of some order data. What you did not
have was the Airtable base the whole thing ran on. Your access ended when the
internship did.

So the app was intact but dead. Every page load tried to reach a database that
would never answer. You couldn't run it, couldn't demo it, couldn't keep
building on it.

The goal: make it run again, then make it better.

---

## The core problem, explained

Before any of the changes make sense, you need this one idea.

Airtable is a database you talk to over the internet. Every question costs a
round trip — your server asks, waits for the network, gets an answer. Each trip
is maybe 50–200 milliseconds. That sounds fast until you make seventy of them
in a row.

Your `server.js` made roughly seventy per page load. Not because it was badly
written, but because of a specific pattern:

```js
// getAvailableDishes — one network request per menu item
for (const menuItem of weeklyMenuRecords) {
    const dishIngredients = await base('Dishes').select({...}).all();  // ← trip
}

// getProteinOptionsForOrder — one network request per protein option
for (const ingredientId of variantIngredientIds) {
    const ingredient = await base('Ingredients').find(ingredientId);   // ← trip
}
```

This is the **N+1 problem**: one query to get a list, then N more queries to get
details about each item in that list. Eighteen menu items means eighteen extra
trips. Eight protein options means eight more.

**Why this matters for what you did before:** during your internship you cut p95
batch time from 77s to 59s by adding caching (`CACHED_VARIANTS`,
`CACHED_STANDARD_SAUCES`). That was the right move — you couldn't change the
data layer, so you cached around it. But caching around an N+1 doesn't remove
the N+1. The work is still proportional to `dishes × ingredients` in round
trips. Cold cache, changed menu, new customer — the slowness comes right back.

That's the ceiling this rebuild breaks through, and it's the honest framing:
the win is structural, not clever.

---

## What got built

Nine files. Four you'd ship, five that exist to prove the first four work.

| File | What it is | Ship it? |
|---|---|---|
| `db/schema.sql` | The database structure — tables, columns, indexes | Yes |
| `db/queries.js` | All data access — the replacement for the Airtable calls | Yes |
| `db/cache.js` | Caching, with real expiry and invalidation | Yes |
| `db/index.js` | Opens the database, wires the pieces together | Yes |
| `server.sqlite.js` | The web server — same routes, new backend | Yes |
| `MealPlanViewer.js` | Rewritten frontend component | Yes |
| `db/seed.js` | Generates fake-but-realistic data | Dev only |
| `bench.js` | Measures speed and query count | Dev only |
| `concurrency.js` | Tests behavior under simultaneous load | Dev only |
| `e2e.js` | Tests every API route over real HTTP | Dev only |

---

## Change 1 — Recovering the database structure

**The problem:** Airtable was gone, so there was no schema to copy. It had to be
reconstructed from evidence.

**Where the evidence came from.** Two sources.

*From the code:* every field `server.js` reads or writes tells you a column
exists. `orderRecord.fields['Final Ingredients with User Edits']` proves that
field. `filterByFormula: {Unique ID} = '${token}'` proves clients are looked up
by a `Unique ID`.

*From the export:* this is the part worth understanding, because it's how the
ingredient data got recovered exactly rather than guessed.

Each order in the JSON has two relevant fields. An array of opaque record IDs:

```json
"Final Ingredients": ["recZzA78OoQJzpvee", "recofihPDUV4HDwxn", "recaQZdcLgl1QMqP7", ...]
```

And a human-readable label printed on the meal sticker:

```json
"Meal Sticker": "The Rainbow Bowl: Roasted Brussel Sprouts, Roasted Red Onions, Carrot, ..."
```

Same order. Same count. So position 1 in the array *is* "Roasted Brussel
Sprouts," position 2 *is* "Roasted Red Onions," and so on. Cross-referencing
across dozens of orders confirms it — `recaQZdcLgl1QMqP7` lands on "Carrot"
every single time, in every dish that contains it.

The ambiguous cases got resolved by the edit trail. One order has:

```json
"Deletions": ["recrXVahIpOSj2xae"],
"Meal Sticker": "... (No Peanut Sesame Sauce, + Vinegar & Oil)"
```

Something was removed, and the sticker says what. That pins
`recrXVahIpOSj2xae` = Peanut Sesame Sauce.

**Result:** 84 ingredients with their real record IDs and real component
classifications, 12 dishes with their real recipes. Not invented — recovered.

**What was deliberately not carried over:** the export contains real customers'
names, home addresses, and phone numbers. None of that is in the fixture. The
five demo customers are synthetic.

**The schema.** Eight tables. A few decisions worth knowing:

*Record IDs kept their `rec...` shape.* `MealPlanViewer.js` uses `recordId` as a
React key and sends it in every request body. Keeping the same format means the
frontend contract didn't change at all.

*Airtable's linked-record arrays became join tables.* Airtable stores
relationships as arrays inside a row. SQL uses a separate table with one row per
relationship. The important one:

```sql
CREATE TABLE order_ingredients (
    order_id      TEXT,
    ingredient_id TEXT,
    kind          TEXT CHECK (kind IN ('original', 'final')),
    sort_order    INTEGER
);
```

Airtable had `Original Ingredients` and `Final Ingredients with User Edits` as
two parallel arrays on the same row. Here it's one table with a `kind` column.
That makes "what did the customer actually change?" a single query instead of
an array-diff in application code.

*Indexes were added where the queries actually look.* An index is a lookup
shortcut — without one, finding a row means scanning every row. Every column the
code filters on has one.

---

## Change 2 — Eliminating the N+1

**This is the change that matters most.**

Those loops in `server.js` become **joins** in SQL. A join tells the database
"give me orders *and* their ingredients *and* those ingredients' names, all at
once." One question, complete answer.

The result, measured on your machine:

```
QUERY COUNT (per full page load)
  SQLite repo                  7
  Airtable equivalent          ~70 network round trips

LATENCY
  repo, no cache               p50    1.26ms   p95    3.31ms   p99    5.24ms
```

**The count is fixed at 7.** Ten dishes or ten thousand, it's still 7 queries.
That's what "structural" means — the shape of the work no longer grows with the
data.

### About those p50 / p95 / p99 numbers

Run something 100 times, sort the results fastest to slowest.

- **p50** — the middle one. Half faster, half slower. "Typical."
- **p95** — 95 out of 100 were at least this fast. Only 5 were worse.
- **p99** — only the slowest 1 in 100 was worse than this.

Averages hide disasters. Ninety-nine requests at 10ms and one at 10 seconds
averages to 110ms, which looks fine — but one person waited ten seconds and
left. p99 catches that; the average buries it.

Your spread is 1.26 → 3.31 → 5.24ms. Only 4x from middle to worst. Tight and
predictable. A bad system looks like `p50 50ms / p99 8000ms`, where most people
are fine and some are furious.

### An important caveat about the numbers

**These are not comparable to your 77s → 59s result.** Different things
entirely:

- 77s → 59s was **batch processing** — bulk order syncs, many orders, over the
  network to Airtable.
- 1.26ms is **one customer's page load** — 74 orders, local disk.

Different operation, different scale, different hardware. Claiming "59s to
2.8ms" would invite an obvious question — *what does the batch job do now?* —
and the answer is that you haven't rebuilt it.

**What you can honestly say:** the read path went from ~70 network round trips
to 7 local queries, and the count no longer grows with the data. Less flashy.
True.

One more honesty note: the `~70` figure is an *estimate*, reconstructed by
counting the loops in `server.js`. Nobody timed the Airtable version against
this fixture, because the base is gone. Don't call it measured.

---

## Change 3 — Caching that can be reasoned about

**What you had:** four module-level globals.

```js
let CACHED_STANDARD_SAUCES = null;      // never expires
let CACHED_INGREDIENT_COMPONENTS = {};  // never expires, never invalidated
let CACHED_VARIANTS = null;             // 5-minute expiry
let CACHE_TIMESTAMP = null;
```

Three different policies, no single place to reason about correctness. And
`CACHED_INGREDIENT_COMPONENTS` never expired *and* never invalidated — change an
ingredient's category in Airtable and the running server serves the stale value
until someone restarts it.

**What replaced it:** one interface with four properties.

**Explicit expiry.** All time-to-live values in one object:

```js
const TTL = {
    reference: 10 * 60 * 1000,   // menu data — changes rarely
    menu:       5 * 60 * 1000,
    mealPlan:        60 * 1000,  // customer data — changes constantly
};
```

**Explicit invalidation.** Every write clears that customer's cached plan before
returning. Without this, someone deletes a meal and it reappears on refresh. TTL
is a safety net; invalidation is the actual correctness mechanism.

**Stampede protection.** Suppose 50 people request the same page at the same
moment and the cache just expired. A naive cache runs the database query 50
times — all 50 miss, all 50 fetch. The fix is to let the first one fetch and
have the other 49 wait for its result:

```
TEST 3  cache stampede on a cold key
  requests fired            50
  loader actually ran       1
  stampede protection       PASS
  (control, cache off)      loader ran 50x
```

50 requests, 1 database query. The control line shows what it looks like
without protection.

**Swappable backend.** Two implementations behind one interface:

- `MemoryBackend` — stores in the process. No setup. **This is what's tested.**
- `RedisBackend` — stores in Redis, shared across processes. **Written but never
  run.** There's no Redis in the test environment and `ioredis` isn't installed.
  Treat it as a sketch with the right shape. Expect to find at least one bug the
  first time you point it at a real server.

The valuable part isn't the Redis class — it's that the interface is async and
string-keyed from the start, so switching is a constructor argument rather than
rewriting every call site. Your old globals were synchronous, so moving *those*
to Redis would have meant touching everything.

---

## Change 4 — Bugs found along the way

Three real ones. Two exist in your original code.

### Bug 1 — Meal type strings don't match what the UI expects

Your data contains `"Dinner Subscriptions"`, `"Dinner "` (trailing space), and
`"Dinner"` for the same concept. But `MealPlanViewer.js` groups strictly:

```js
['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(mealType => {
    const mealOrders = orders.filter(order => order.meal === mealType);
```

`"Dinner Subscriptions" === "Dinner"` is false. So that card comes back in the
API response, passes every check, and **renders nowhere**. It exists in the data
and is invisible on screen — the worst kind of bug, because nothing errors.

Fixed with a `canonicalMeal()` function that normalizes at the boundary.

### Bug 2 — Reducing quantity can delete the wrong row

Your quantity model is one database row per serving. Three servings = three
rows. Reducing to one means deleting two.

Your original picks which to delete like this:

```js
const recordsToDelete = allRecordsForDish.slice(quantity).map(r => r.id);
```

`slice(1)` keeps the first and deletes the rest — but nothing guarantees *which*
row is first. Airtable returns records in whatever order it likes. So the row
the user is actively looking at can be the one deleted, leaving the browser
holding a `recordId` that no longer exists. Next click: 404.

It would show up as *"I went from 3 to 1 and now I can't edit the one that's
left."* Intermittent. Miserable to reproduce.

**How it was found:** the e2e test caught it. My first version had the same bug
in a subtler form — I ordered by `created_at, id`, but rows created in the same
second tie on `created_at` and fall back to a random ID. The test failed, which
is exactly what tests are for.

The fix pins the row being acted on to the front:

```sql
ORDER BY (id = ?) DESC, created_at, id
```

### Bug 3 — A dead endpoint that throws

In `PATCH /api/orders/:token/ingredients`:

```js
'Customer Edits': customerEdits + ... + ingredientName + ' ' + (shouldActivate ? ...)
```

Neither `ingredientName` nor `shouldActivate` exists in that function's scope.
It throws a `ReferenceError` the moment it runs. It's dead code — the frontend
uses `/ingredients/toggle` instead — but it'll bite whoever wires it up.

---

## Change 5 — Rewriting the frontend component

The backend was fast, but the UI had a visible bug: swap a protein, the server
updates correctly, and the checkmark stays on the old one until you reload.

### The real cause

Your components were defined **inside** the main component:

```js
export default function MealPlanViewer() {
    // ...
    const CompactMealCard = ({ meal, actualIndex }) => (...)      // ← inside
    const MealModal = ({ meal, onClose }) => (...)                // ← inside
    const ProteinSubstitutionSection = ({ order }) => {...}       // ← inside
```

Every time `MealPlanViewer` re-renders, JavaScript creates *brand new function
objects* for these. React identifies components by their function identity. New
identity means "different component," so React throws away the old one and
builds a fresh one from scratch — new DOM nodes, lost scroll position, lost
focus, discarded state.

**This is why `flushSync` and the scroll-saving code existed.** Eight handlers,
each doing:

```js
const scrollTop = modelRef.current?.scrollTop || 0;
// ... do the work ...
flushSync(() => { setOrders(updatedOrders); });
modalRef.current.scrollTop = scrollTop;   // put scroll back
```

That's compensating for a remount that shouldn't have been happening. You were
right to dislike `flushSync` — it was a symptom.

### The fixes

**1. Components moved to module scope.** Defined once, stable identity forever.
React reconciles instead of remounting. Every `flushSync` and every scroll
save/restore deleted — they were treating a cause that no longer exists.

**2. Server became the source of truth.** You had eight separate blocks
hand-patching local state after each mutation — eight different reconstructions
of `orders`, eight chances to get one subtly wrong. That's exactly how the
checkmark drifted.

All eight collapsed into one:

```js
const mutate = async (fn, successMsg) => {
    await fn();          // do the thing
    await load(true);    // refetch, no spinner
    flash(successMsg);
};
```

This is only possible *because* of the backend work. Refetching cost seconds
against Airtable — hence the optimistic updates. It costs 3ms now. One source of
truth, and the whole bug class disappears because there's no local copy to
drift.

**3. Cards identified by `recordId`, not array position.** `actualIndex` was a
position into an array that gets re-sorted on every quantity change. A modal
held open across a mutation could end up pointing at a different dish.

The modal now reads its data live:

```js
const openMeal = openRecordId
    ? allOrders.find(o => o.recordId === openRecordId)
    : null;
```

When a refetch lands, the modal re-renders from fresh server data
automatically. **This is the actual fix for the checkmark.**

**4. Five components became one.** `ProteinSubstitutionSection`,
`SauceSubstitutionSection`, `GarnishSubstitutionSection`,
`VeggieSubstitutionSection`, `StarchSubstitutionSection` were near-identical —
a label plus clickable chips. They differ only in whether selecting replaces the
current choice or toggles it. One `OptionGroup` with `mode="replace"` or
`mode="toggle"` covers all five.

### The result

| | Before | After |
|---|---|---|
| Lines | ~1450 | 842 |
| `flushSync` calls | 8 | 0 |
| Scroll save/restore blocks | 8 | 0 |
| State-patching blocks | 8 | 1 |
| `useState` hooks | 14 | 11 |
| Substitution components | 5 | 1 |

---

## Change 6 — Tests

Four programs, testing different layers.

**`bench.js`** — calls the data layer directly, no web server. Counts queries,
measures latency percentiles, verifies cache invalidation.

**`concurrency.js`** — simulates simultaneous users. Three questions: do
parallel reads queue up behind each other (no), does stampede protection work
(yes), does throughput hold as load climbs (yes).

Your scaling results:

```
  concurrency   wall      per-req    req/s
            1       1ms      1.00ms     1000
           10      10ms      1.00ms     1000
           25      25ms      1.00ms     1000
           50      49ms      0.98ms     1020
          100      94ms      0.94ms     1064
          200     209ms      1.04ms      957
```

Flat per-request time across a 200x range in load. If requests were queueing,
that column would climb — 1ms, then 10ms, then 100ms.

*Caveat:* Node runs on one thread, so this measures how your actual server
behaves (requests interleaving on one event loop), not multi-core parallelism.
That's the right thing to measure for your deployment, but don't call it a
multi-core benchmark.

**`e2e.js`** — 60 assertions over real HTTP against a running server. This is
the one that found the quantity bug.

Critically, it checks response **shapes**, not just status codes:

```js
for (const f of ['recordId', 'dishId', 'itemName', 'quantity', 'deliveryDate',
                 'meal', 'ingredients', 'sauceOptions', 'proteinOptions', ...]) {
    check(`card.${f} present`, card[f] !== undefined);
}
```

A route returning 200 with wrong field names still breaks the UI — silently,
because React renders `undefined` as nothing.

**`seed.js`** — builds the fixture. Five customers including one deliberate edge
case (subscribed, zero orders) that exercises a code path the others don't.

---

## What's verified and what isn't

Being precise about this matters more than the green checkmarks.

| Layer | Verified by | Status |
|---|---|---|
| Database structure | `seed.js` runs | ✅ |
| Data access | `bench.js` — 7 queries, fixed | ✅ |
| Cache correctness | invalidation + stampede | ✅ |
| Concurrent load | `concurrency.js` — no serialization | ✅ |
| HTTP routes | `e2e.js` — 60/60 | ✅ |
| Browser rendering | manual click-through | ✅ (partial) |
| Redis backend | — | ❌ **never run** |
| Scale (500+ customers) | — | ❌ not tested |
| Batch/sync job | — | ❌ not rebuilt |

Three things worth being skeptical about in your own numbers:

**The dataset is small.** 74 orders, 84 ingredients. At that size SQLite reads a
page or two from memory — you're partly benchmarking RAM, not the query planner.
The joins are indexed and should scale, but "should" is doing work there.

**The warm-cache number is nearly meaningless.** `0.001ms` is a Map lookup in
the same process. With Redis it'd be 0.5–2ms — still faster than the query, but
a thousand times slower than what you're seeing. And `1000000 req/s` in TEST 2
is the millisecond timer bottoming out, not a real throughput figure.

**The `~70 round trips` comparison is estimated, not measured.**

---

## How to run it

```bash
# Backend
cd ~/cmu/Landingpage/backend
npm install better-sqlite3 express
node db/seed.js --force
node server.sqlite.js               # port 3001

# Frontend (separate terminal)
cd ~/cmu/Landingpage/landingpage
npm start                            # port 3000
```

Open `http://localhost:3000/meal-plan?customer=sf-demo-0001`

Tests:

```bash
node e2e.js          # needs the server running
node bench.js
node concurrency.js
```

Both `bench.js` and `e2e.js` modify the database — that's how they prove writes
work. Re-seed between runs for clean numbers.

### Demo customers

| Token | Customer | Why it exists |
|---|---|---|
| `sf-demo-0001` | Dana Whitfield | All four meal types; one order has saved customizations |
| `sf-demo-0002` | Marcus Oyelaran | High macros, no breakfast |
| `sf-demo-0003` | Priya Raman | Vegetarian, breakfast-heavy |
| `sf-demo-0004` | Elliot Nakashima | Pescatarian, no snacks |
| `sf-demo-0005` | Rosa Delgado | **Zero orders** — exercises the empty branch |

---

## Talking about this accurately

**Don't say:** "Reduced latency from 59s to 2.8ms."

Those measure different operations. 59s was batch sync; 2.8ms is a single page
read on local disk. A competent interviewer will ask what the batch job does
now, and you haven't rebuilt it.

**Do say:** "Replaced an N+1 data access pattern — roughly 70 network round
trips per page load — with a relational layer that does 7 queries regardless of
data size. Verified no read serialization and single-loader cache behavior
under 200-way concurrency."

That's specific, defensible, and every claim in it has a number behind it. It
also invites good follow-up questions:

- *"How did you find the N+1?"* — Reading the loops in the original handler.
- *"How do you know the cache is correct?"* — Explicit invalidation on write,
  verified by an integration test that mutates and re-reads.
- *"What broke?"* — A quantity-decrease path that could delete the row the user
  was holding. Caught by the e2e test. Same bug exists in the original.

That last answer is the strongest one available, because finding a real bug in
your own prior work and explaining why it was invisible demonstrates more than
any latency number.

---

## What's left

**Immediate:**
- Click through the rewritten `MealPlanViewer` — protein swap, +$4 modal, date
  tabs, add/remove. The e2e tests cover the API, not the rendering.
- Delete `MealPlanViewer.old.js` once you trust the new one.

**Worth doing:**
- Scale the fixture to ~500 customers and re-run `bench.js`. If query count
  stays 7 and p99 stays low, that's a much stronger claim.
- Stand up Redis and actually test `RedisBackend`.

**Bigger:**
- **Reconsider one-row-per-serving.** Setting quantity to 3 creates two rows;
  setting it to 1 deletes two. That model is the source of the deletion bug, and
  it's why the old frontend needed temporary IDs and reconciliation. A
  `quantity` column on a single row would delete complexity on both sides.
- Rebuild the batch sync job — that's where your original 59s number lived.
- `server.js` and `airtable.js` can be deleted once everything's confirmed. Keep
  them until then; they're the only surviving documentation of a system that
  can't be queried anymore.
