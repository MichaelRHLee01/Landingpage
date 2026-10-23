-- Square Fare — SQLite schema
--
-- Reverse-engineered from server.js, airtable.js, and airtable_output.json.
--
-- DESIGN NOTE ON PRIMARY KEYS:
-- Primary keys are TEXT and keep the Airtable "rec..." shape. This is
-- deliberate. MealPlanViewer.js treats `recordId` as an opaque string and
-- uses it as a React key and as the identifier in every PATCH body. Keeping
-- the same ID shape means the frontend contract does not change at all.
--
-- DESIGN NOTE ON LINKED RECORDS:
-- Airtable "linked record" fields are arrays of record IDs. In SQL these
-- become join tables. The important one is order ingredients: Airtable stored
-- `Original Ingredients` and `Final Ingredients with User Edits` as two
-- parallel arrays on the same row. Here they are one join table with a `kind`
-- discriminator, which makes "what did the customer actually change" a single
-- query instead of an array diff in application code.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- CLIENT
-- ---------------------------------------------------------------------------
-- One row per (person, meal type). This is how Airtable had it: a customer
-- subscribed to Breakfast and Dinner has TWO client rows sharing one Unique ID.
-- server.js relies on this — see the `allClientRecords.find(r => r.Meal === mealType)`
-- lookup in the add-dish endpoint.

CREATE TABLE clients (
    id                  TEXT PRIMARY KEY,
    unique_id           TEXT NOT NULL,          -- the customer token in the URL
    first_name          TEXT,
    last_name           TEXT,
    email               TEXT,                   -- was TypyForm_Email
    meal                TEXT,                   -- Breakfast | Lunch | Dinner | Snack
    identifier          TEXT,                   -- "Name | Meal | email"
    goal_calories       REAL DEFAULT 0,
    goal_carbs_g        REAL DEFAULT 0,
    goal_protein_g      REAL DEFAULT 0,
    goal_fat_g          REAL DEFAULT 0,
    goal_fiber_g        REAL DEFAULT 0,
    notes               TEXT DEFAULT '',
    snacks_per_day      INTEGER DEFAULT 0
);

-- The single hottest lookup in the app: every request starts by resolving a token.
CREATE INDEX idx_clients_unique_id ON clients(unique_id);
CREATE INDEX idx_clients_unique_id_meal ON clients(unique_id, meal);

-- ---------------------------------------------------------------------------
-- INGREDIENTS
-- ---------------------------------------------------------------------------
-- `component` is the field the whole substitution UI pivots on. server.js
-- branches on the literal strings 'Meat', 'Sauce', 'Garnish', 'Veggies', 'Starch'.

CREATE TABLE ingredients (
    id                  TEXT PRIMARY KEY,
    ingredient_id       TEXT,                   -- human-readable code, e.g. "SF Citrus Vinaigrette"
    ingredient_name     TEXT NOT NULL,
    usda_name           TEXT,
    component           TEXT                    -- Meat | Sauce | Garnish | Veggies | Starch | Fruit | Dairy | Nuts/Seeds
);

CREATE INDEX idx_ingredients_component ON ingredients(component);
CREATE INDEX idx_ingredients_ingredient_id ON ingredients(ingredient_id);

-- ---------------------------------------------------------------------------
-- DISHES  (recipe definitions: which ingredients make up a dish for a meal type)
-- ---------------------------------------------------------------------------

CREATE TABLE dishes (
    id                  TEXT PRIMARY KEY,
    dish_id             INTEGER NOT NULL,       -- the numeric ID used everywhere else
    type_of_meal        TEXT NOT NULL           -- may hold several, e.g. "Lunch, Dinner"
);

CREATE INDEX idx_dishes_dish_id ON dishes(dish_id);

CREATE TABLE dish_ingredients (
    dish_pk             TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    ingredient_id       TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    sort_order          INTEGER DEFAULT 0,
    PRIMARY KEY (dish_pk, ingredient_id)
);

CREATE INDEX idx_dish_ingredients_ingredient ON dish_ingredients(ingredient_id);

-- ---------------------------------------------------------------------------
-- PRODUCTS / WEEKLY MENU  (what is orderable this week)
-- ---------------------------------------------------------------------------

CREATE TABLE weekly_menu (
    id                          TEXT PRIMARY KEY,
    internal_dish_id            INTEGER NOT NULL,
    item_name                   TEXT NOT NULL,  -- Airtable ItemName
    product_title               TEXT,
    meals                       TEXT,           -- Breakfast | Lunch | Dinner | Snack
    status                      TEXT DEFAULT 'active',
    exclude_from_subscriptions  INTEGER DEFAULT 0,
    image_url                   TEXT
);

CREATE INDEX idx_weekly_menu_dish_id ON weekly_menu(internal_dish_id);
-- Covers the getAvailableDishes filter directly.
CREATE INDEX idx_weekly_menu_active ON weekly_menu(status, exclude_from_subscriptions, meals);

-- ---------------------------------------------------------------------------
-- SUBSCRIPTIONS  (how many meals of each type the customer is entitled to)
-- ---------------------------------------------------------------------------

CREATE TABLE subscriptions (
    id                  TEXT PRIMARY KEY,
    customer_name       TEXT NOT NULL,
    meal                TEXT,
    meals_included      INTEGER DEFAULT 0,
    next_delivery_date  TEXT                    -- ISO yyyy-mm-dd
);

CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_name);

-- ---------------------------------------------------------------------------
-- VARIANTS  (the substitution engine's rule table)
-- ---------------------------------------------------------------------------
-- `price` > 0 is what drives the premium-protein upsell confirmation modal.

CREATE TABLE variants (
    id                  TEXT PRIMARY KEY,
    variant_name        TEXT,
    variant_type        TEXT,                   -- Protein/Veggie/Starch Substitution
    applicable_to       TEXT,                   -- substring-matched against meal type
    price               REAL DEFAULT 0,
    availability        INTEGER DEFAULT 1
);

CREATE INDEX idx_variants_type ON variants(variant_type, availability);

CREATE TABLE variant_ingredients (
    variant_id          TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    ingredient_id       TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    PRIMARY KEY (variant_id, ingredient_id)
);

-- This index is what turns "find the variant group this protein belongs to"
-- from a full scan of every variant into a point lookup.
CREATE INDEX idx_variant_ingredients_ingredient ON variant_ingredients(ingredient_id);

-- ---------------------------------------------------------------------------
-- OPEN ORDERS
-- ---------------------------------------------------------------------------
-- One row = one serving. Quantity 2 means two rows, matching the Airtable
-- behaviour server.js implements (increase => create N rows, decrease => destroy).

CREATE TABLE open_orders (
    id                      TEXT PRIMARY KEY,
    order_subscription_id   TEXT,
    quantity                INTEGER DEFAULT 1,
    source                  TEXT,               -- 'New Recommendation' | 'Subscription Landing Page' | ...
    item_name               TEXT,
    selected_protein        TEXT,
    squarespace_item_id     TEXT,
    meal_portion            TEXT NOT NULL,      -- 'Dinner Subscriptions' etc.
    customer_name           TEXT,
    delivery_date           TEXT,
    dish_id                 INTEGER,
    client_id               TEXT REFERENCES clients(id) ON DELETE SET NULL,
    nutrition_notes         TEXT DEFAULT '',
    customer_edits          TEXT DEFAULT '',    -- append-only audit log
    email                   TEXT,
    meal_sticker            TEXT,
    order_placed_at         TEXT,
    created_at              TEXT DEFAULT (datetime('now')),
    updated_at              TEXT DEFAULT (datetime('now'))
);

-- The main GET filters on client + quantity > 0, then groups by delivery date.
CREATE INDEX idx_open_orders_client ON open_orders(client_id, quantity);
CREATE INDEX idx_open_orders_delivery ON open_orders(client_id, delivery_date);
-- Supports the dedupe check in add-dish and the decrease path in /quantity.
CREATE INDEX idx_open_orders_dish_lookup ON open_orders(client_id, dish_id, meal_portion, delivery_date);

-- Ingredient state per order.
-- kind='original' -> the recipe as generated
-- kind='final'    -> the recipe after customer edits
CREATE TABLE order_ingredients (
    order_id            TEXT NOT NULL REFERENCES open_orders(id) ON DELETE CASCADE,
    ingredient_id       TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('original', 'final')),
    sort_order          INTEGER DEFAULT 0,
    PRIMARY KEY (order_id, ingredient_id, kind)
);

CREATE INDEX idx_order_ingredients_lookup ON order_ingredients(order_id, kind);

-- ---------------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------------
-- Resolves an order's *effective* ingredient list in one place, encoding the
-- "use final if any exist, else fall back to original" rule that is currently
-- repeated in seven different endpoints in server.js.

CREATE VIEW order_effective_ingredients AS
SELECT
    o.id                AS order_id,
    i.id                AS ingredient_id,
    i.ingredient_name,
    i.component,
    oi.sort_order,
    oi.kind
FROM open_orders o
JOIN order_ingredients oi
    ON oi.order_id = o.id
   AND oi.kind = CASE
        WHEN EXISTS (
            SELECT 1 FROM order_ingredients f
            WHERE f.order_id = o.id AND f.kind = 'final'
        ) THEN 'final'
        ELSE 'original'
   END
JOIN ingredients i ON i.id = oi.ingredient_id;
