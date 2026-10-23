/**
 * Square Fare — seed script
 *
 * PROVENANCE: the ingredient record IDs and component classifications below are
 * NOT invented. They were recovered from airtable_output.json by aligning each
 * order's `Final Ingredients` array against its `Meal Sticker` string, which is
 * positionally exact. Deletions/New Ingredients fields confirmed the rest
 * (e.g. an order dropping recrXVahIpOSj2xae has a sticker reading
 * "No Peanut Sesame Sauce", which pins that ID to that ingredient).
 *
 * Customers are synthetic — the export contains real names, addresses, and
 * phone numbers, and there is no reason to carry that into a dev fixture.
 *
 * Usage:  node db/seed.js [--out squarefare.db] [--force]
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const DB_PATH = outFlag !== -1 ? argv[outFlag + 1] : path.join(__dirname, '..', 'squarefare.db');
const FORCE = argv.includes('--force');

if (fs.existsSync(DB_PATH)) {
    if (!FORCE) {
        console.error(`Refusing to overwrite ${DB_PATH}. Re-run with --force.`);
        process.exit(1);
    }
    fs.unlinkSync(DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
    }
}

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ===========================================================================
// INGREDIENTS  — [recordId, ingredientCode, name, component]
// ===========================================================================
// `component` drives the entire substitution UI. server.js branches on these
// exact strings, so they must match: Meat, Sauce, Garnish, Veggies, Starch.
//
// NOTE on 'Meat': this is the *protein slot*, not literally meat. Tofu, tempeh,
// eggs and the breakfast dairies are all tagged 'Meat' because getCurrentProteinId()
// finds the swappable protein by looking for component === 'Meat'. Retagging them
// would silently disable protein substitution on those dishes.

const INGREDIENTS = [
    // --- proteins (protein slot) ---
    ['recuh74IVoEsaycHr', '1001 Chicken',   'Grilled Chicken',        'Meat'],
    ['recznARsvi4UC12bK', '1002 Salmon',    'Grilled Salmon',         'Meat'],
    ['rec2Dspa6mYHaSdpv', '1003 Branzino',  'Grilled Branzino',       'Meat'],
    ['rec46LtJEh2c73v9o', '1004 Pork',      'Grilled Pork',           'Meat'],
    ['recyTARGVt8AvckE9', '1005 Tofu',      'Roasted Tofu',           'Meat'],
    ['reclkqyPaqhCsXtxQ', '1006 Tempeh',    'Tempeh',                 'Meat'],
    ['recVHJbaeV6Dofueq', '1007 Egg',       'Egg',                    'Meat'],
    ['recGE6MCzTC0Bbjcs', '1008 Egg',       'Egg',                    'Meat'],
    ['recyw8Cp9l09KnVIX', '1009 OatsDairy', 'Overnight Oats Dairy',   'Meat'],
    ['rec8QI7OleQoOILwO', '1010 OatsVegan', 'Overnight Oats Vegan',   'Meat'],
    ['recFV48sYPeTYdmDD', '1011 GreekYog',  'Low Fat Greek Yoghurt',  'Meat'],
    ['rec8RoEQf6Ei4lzLV', '1012 CocoYog',   'Coconut Yogurt',         'Meat'],

    // --- veggies ---
    ['recZzA78OoQJzpvee', '2001', 'Roasted Brussel Sprouts', 'Veggies'],
    ['recofihPDUV4HDwxn', '2002', 'Roasted Red Onions',      'Veggies'],
    ['recaQZdcLgl1QMqP7', '2003', 'Carrot',                  'Veggies'],
    ['recwKT0RQCm3iGphr', '2004', 'Purple Cabbage',          'Veggies'],
    ['reckaRs0GP19W461B', '2005', 'Roasted Eggplants',       'Veggies'],
    ['rec6HFjvNr7fkKodv', '2006', 'Bok Choy',                'Veggies'],
    ['recLuDHJDwX5luA7C', '2007', 'Roasted Shiitake Mushroom', 'Veggies'],
    ['recejYagu5Wjsg11Q', '2008', 'Pickled Cabbage',         'Veggies'],
    ['recHszIjL76PUu8Xu', '2009', 'Roasted Onion',           'Veggies'],
    ['recavQPw2Qrjo0FGW', '2010', 'Roasted Tomatoes',        'Veggies'],
    ['recub4EmMCqPNu7mt', '2011', 'Roasted Asparagus',       'Veggies'],
    ['rechRYTVZ6p7K8008', '2012', 'Kale',                    'Veggies'],
    ['recp0vcOJKjqqdOoD', '2013', 'Fennel',                  'Veggies'],
    ['recLBElYZHddI4GAM', '2014', 'Broccolini',              'Veggies'],
    ['recHw14OEoXKX5E7Q', '2015', 'Roasted Peppers',         'Veggies'],
    ['recSD1162AyoxmL7W', '2016', 'Radicchio',               'Veggies'],
    ['rec8Pf56MKUub3X8h', '2017', 'Green Bean',              'Veggies'],
    ['rec8OMHT97qpFEFZI', '2018', 'Snap Peas',               'Veggies'],
    ['recVwZ4lTJYxbGtGn', '2019', 'Chayote',                 'Veggies'],
    ['rec2uUXjiqG1jzCAj', '2020', 'White Beans',             'Veggies'],
    ['recAIlumi8yxmE6h6', '2021', 'Celery',                  'Veggies'],
    ['recs6uW07zyMQMvwn', '2022', 'Roasted Zucchini',        'Veggies'],
    ['rec81mQS6zzE4ktp0', '2023', 'Broccoli',                'Veggies'],
    ['recpmb7WY5xUnyg2b', '2024', 'Red Cabbage',             'Veggies'],
    ['recfD6DqB7yFCct9H', '2025', 'Steamed Shelled Edamame', 'Veggies'],
    ['recoWmxN5efks3cIz', '2026', 'Roasted Carrots',         'Veggies'],
    ['rec4pr8Pm0G7ws9Ew', '2027', 'Roasted Broccoli',        'Veggies'],
    ['recu8baGyvWxPZVOq', '2028', 'Arugula',                 'Veggies'],
    ['recyzE0xpFHq7BpTW', '2029', 'Red Chili Peppers',       'Veggies'],
    ['recpQmfRYpF9zitWx', '2030', 'Sautéed Mustard Greens',  'Veggies'],
    ['rec8zrWxwYsIYRTW1', '2031', 'Red Beans',               'Veggies'],

    // --- starches ---
    ['recLuswBMZWljd0SQ', '3001', 'Amaranth',                 'Starch'],
    ['rec4b9CN4MxAquLF0', '3002', 'Brown Rice Noodles',       'Starch'],
    ['rec7MJSyWoVzosvg9', '3003', 'Roasted Butternut Squash', 'Starch'],
    ['rec1MmjWcS6Kw1cJ5', '3004', 'Edamame Pasta',            'Starch'],
    ['recda9SnRJ3aMd6mV', '3005', 'Corn Tortilla',            'Starch'],
    ['recosAP8fTB9TvpKB', '3006', 'Granola with Nuts',        'Starch'],
    ['rec8vY7519jeoivsq', '3007', 'Roasted Butternut Squash', 'Starch'],

    // --- sauces ---
    // The three with 'SF '/'9156 ' codes are the standard sauces hardcoded in
    // getStandardSauces(). Those literals must not drift.
    ['recc9OV0peH0ozfsh', 'SF Vinegar & Oil',      'Vinegar & Oil',              'Sauce'],
    ['recVinCitrus001Aa', 'SF Citrus Vinaigrette', 'Citrus Vinaigrette',         'Sauce'],
    ['recZJAJXBjPX3xoWj', '9156 Lemon',            'Lemon',                      'Sauce'],
    ['reci3I0ppqDdY7E1q', '4001', 'Tahini Dressing',              'Sauce'],
    ['recrXVahIpOSj2xae', '4002', 'Peanut Sesame Sauce',          'Sauce'],
    ['recK8ToMqtfOIum9b', '4003', 'Nut-Free Basil Pesto',         'Sauce'],
    ['recLZhMpSytX88RMz', '4004', 'Roasted Tomato & Herb Dressing', 'Sauce'],
    ['rectdmSRIuV3NcYju', '4005', 'Kuah Kuning Sauce',            'Sauce'],
    ['rec315cBr06ocdB1o', '4006', 'Birria Sauce',                 'Sauce'],
    ['recU0cQv4JzrqBNLt', '4007', 'Herby Vinaigrette',            'Sauce'],
    ['recQCz8SyOUvY3uTG', '4008', 'Peri Peri Sauce',              'Sauce'],

    // --- garnishes ---
    ['recgSOIaOjutXmJyF', '5001', 'Pepitas',            'Garnish'],
    ['rec6f0pQAXgp4BWbb', '5002', 'Scallions',          'Garnish'],
    ['recv6lPONqZc4OlVr', '5003', 'Sesame Seeds',       'Garnish'],
    ['recgw6ug0L58knchp', '5004', 'Parsley',            'Garnish'],
    ['rece1JqiSKMxrlvpD', '5005', 'Lemon Zest',         'Garnish'],
    ['recezMfburmg6Dmi8', '5006', 'Hazelnuts',          'Garnish'],
    ['rec1RUcycTQGQ5L6X', '5007', 'Sundried Tomato',    'Garnish'],
    ['recK8gR1HcseyZYnv', '5008', 'Garlic',             'Garnish'],
    ['rechrCRoh1om4yYg7', '5009', 'Crispy Shallot',     'Garnish'],
    ['recpmLM1FnWzYQiZo', '5010', 'Cilantro',           'Garnish'],
    ['rec9OrOiJ1Bs74WHC', '5011', 'Celery Leaves',      'Garnish'],
    ['recVE2UWTnmPKsYTi', '5012', 'Cotija Cheese',      'Garnish'],
    ['recgsytubWUFV6HOu', '5013', 'Pickled Red Onions', 'Garnish'],
    ['rec9xof1qsNVUJO5K', '5014', 'Parsley',            'Garnish'],
    ['rec5lrMQuW8o2WQXL', '5015', 'Goat Cheese',        'Garnish'],
    ['recZrpfnwCgBvwvbR', '5016', 'Maple Syrup',        'Garnish'],
    ['recARzMl49rn2BuVT', '5017', 'Dried Apricot',      'Garnish'],

    // --- fruit / nuts (snack + breakfast) ---
    ['recHna21TuXXKmAln', '6001', 'Strawberries',            'Fruit'],
    ['recGNHEEIilXaykxa', '6002', 'Blueberries',             'Fruit'],
    ['recZnW4QVw5VQgPBg', '6003', 'Apple',                   'Fruit'],
    ['recclt26M0JiWNZCA', '6004', 'Rhubarb & Apple Compote', 'Fruit'],
    ['rec5jRloJKxUTxjYp', '6005', 'Sunflower Seeds',         'Nuts/Seeds'],
    ['recXHq57dMR6icvX4', '6006', 'Walnuts',                 'Nuts/Seeds'],
];

// ===========================================================================
// DISHES  — dishId, mealTypes, itemName, ingredient list (recipe order)
// ===========================================================================

const DISHES = [
    {
        dishId: 801, meals: ['Lunch', 'Dinner'], name: 'The Rainbow Bowl',
        ingredients: ['recZzA78OoQJzpvee', 'recofihPDUV4HDwxn', 'recaQZdcLgl1QMqP7',
            'recwKT0RQCm3iGphr', 'reckaRs0GP19W461B', 'recznARsvi4UC12bK',
            'recLuswBMZWljd0SQ', 'reci3I0ppqDdY7E1q', 'recgSOIaOjutXmJyF', 'recZJAJXBjPX3xoWj'],
    },
    {
        dishId: 802, meals: ['Lunch', 'Dinner'], name: 'Peanut Noodle Bowl',
        ingredients: ['rec6HFjvNr7fkKodv', 'recLuDHJDwX5luA7C', 'recaQZdcLgl1QMqP7',
            'recyTARGVt8AvckE9', 'rec4b9CN4MxAquLF0', 'recrXVahIpOSj2xae',
            'recejYagu5Wjsg11Q', 'rec6f0pQAXgp4BWbb', 'recv6lPONqZc4OlVr'],
    },
    {
        dishId: 800, meals: ['Lunch', 'Dinner'], name: 'Spring Pesto Bowl',
        ingredients: ['recHszIjL76PUu8Xu', 'recavQPw2Qrjo0FGW', 'recub4EmMCqPNu7mt',
            'rechRYTVZ6p7K8008', 'recp0vcOJKjqqdOoD', 'recuh74IVoEsaycHr',
            'rec7MJSyWoVzosvg9', 'recK8ToMqtfOIum9b', 'recgw6ug0L58knchp', 'rece1JqiSKMxrlvpD'],
    },
    {
        dishId: 804, meals: ['Lunch', 'Dinner'], name: 'Tuscan Bowl',
        ingredients: ['recHszIjL76PUu8Xu', 'recavQPw2Qrjo0FGW', 'recHw14OEoXKX5E7Q',
            'recLBElYZHddI4GAM', 'recSD1162AyoxmL7W', 'recp0vcOJKjqqdOoD',
            'rec2Dspa6mYHaSdpv', 'rec7MJSyWoVzosvg9', 'recLZhMpSytX88RMz',
            'recK8gR1HcseyZYnv', 'rec1RUcycTQGQ5L6X', 'recezMfburmg6Dmi8'],
    },
    {
        dishId: 805, meals: ['Lunch', 'Dinner'], name: 'Indonesian Bowl',
        ingredients: ['rec8Pf56MKUub3X8h', 'recaQZdcLgl1QMqP7', 'rec8OMHT97qpFEFZI',
            'recVwZ4lTJYxbGtGn', 'recVHJbaeV6Dofueq', 'rec2uUXjiqG1jzCAj',
            'rec1MmjWcS6Kw1cJ5', 'rectdmSRIuV3NcYju', 'recAIlumi8yxmE6h6',
            'rechrCRoh1om4yYg7', 'recpmLM1FnWzYQiZo', 'rec9OrOiJ1Bs74WHC'],
    },
    {
        dishId: 803, meals: ['Lunch', 'Dinner'], name: 'Birria Taco Bowl',
        ingredients: ['recs6uW07zyMQMvwn', 'rec81mQS6zzE4ktp0', 'recHw14OEoXKX5E7Q',
            'recpmb7WY5xUnyg2b', 'rec46LtJEh2c73v9o', 'recda9SnRJ3aMd6mV',
            'rec315cBr06ocdB1o', 'recpmLM1FnWzYQiZo', 'recVE2UWTnmPKsYTi', 'recgsytubWUFV6HOu'],
    },
    {
        dishId: 794, meals: ['Lunch'], name: 'Peri Peri Bowl',
        ingredients: ['rec81mQS6zzE4ktp0', 'recyzE0xpFHq7BpTW', 'recARzMl49rn2BuVT',
            'recpQmfRYpF9zitWx', 'rec8zrWxwYsIYRTW1', 'recHw14OEoXKX5E7Q',
            'recpmLM1FnWzYQiZo', 'recgSOIaOjutXmJyF', 'recs6uW07zyMQMvwn',
            'recQCz8SyOUvY3uTG', 'recyTARGVt8AvckE9'],
    },
    {
        dishId: 597, meals: ['Breakfast'], name: 'Overnight Oats with Chia Seeds and Fresh Berries',
        ingredients: ['recGNHEEIilXaykxa', 'recHna21TuXXKmAln', 'recyw8Cp9l09KnVIX', 'recZrpfnwCgBvwvbR'],
    },
    {
        dishId: 798, meals: ['Breakfast'], name: 'Parfait',
        ingredients: ['recclt26M0JiWNZCA', 'recFV48sYPeTYdmDD', 'recosAP8fTB9TvpKB'],
    },
    {
        dishId: 799, meals: ['Breakfast'], name: 'Goat Cheese & Herbs Breakfast Bowl',
        ingredients: ['rec9xof1qsNVUJO5K', 'recoWmxN5efks3cIz', 'rec4pr8Pm0G7ws9Ew',
            'recU0cQv4JzrqBNLt', 'recu8baGyvWxPZVOq', 'rec8vY7519jeoivsq',
            'recVHJbaeV6Dofueq', 'rec5lrMQuW8o2WQXL'],
    },
    {
        dishId: 606, meals: ['Snack'], name: 'Seasonal Fruit Salad',
        ingredients: ['recHna21TuXXKmAln', 'recGNHEEIilXaykxa', 'recZnW4QVw5VQgPBg',
            'rec5jRloJKxUTxjYp', 'recXHq57dMR6icvX4'],
    },
    {
        dishId: 806, meals: ['Snack'], name: 'Edamame',
        ingredients: ['recfD6DqB7yFCct9H', 'recv6lPONqZc4OlVr'],
    },
];

// ===========================================================================
// VARIANTS  (substitution rules)
// ===========================================================================
// server.js resolves options by: find the variant containing the current
// protein -> read its Variant Type -> return every variant of that type whose
// `applicable_to` contains the meal type. So one variant row == one option.

const VARIANTS = [
    // Bowl proteins — Lunch + Dinner. Salmon/Branzino carry the upsell price
    // that triggers PriceConfirmationModal in the frontend.
    ['Chicken',         'Bowl Protein', 'Lunch, Dinner', 0, ['recuh74IVoEsaycHr']],
    ['Tofu',            'Bowl Protein', 'Lunch, Dinner', 0, ['recyTARGVt8AvckE9']],
    ['Tempeh',          'Bowl Protein', 'Lunch, Dinner', 0, ['reclkqyPaqhCsXtxQ']],
    ['Pork Tenderloin', 'Bowl Protein', 'Lunch, Dinner', 0, ['rec46LtJEh2c73v9o']],
    ['Boiled',          'Bowl Protein', 'Lunch, Dinner', 0, ['recGE6MCzTC0Bbjcs']],
    ['Scrambled',       'Bowl Protein', 'Lunch, Dinner', 0, ['recVHJbaeV6Dofueq']],
    ['Salmon',          'Bowl Protein', 'Lunch, Dinner', 4, ['recznARsvi4UC12bK']],
    ['Branzino',        'Bowl Protein', 'Lunch, Dinner', 4, ['rec2Dspa6mYHaSdpv']],

    // Breakfast base swaps (the "protein slot" for breakfast dishes)
    ['Cowmilk Dairy', 'Breakfast Base', 'Breakfast', 0, ['recyw8Cp9l09KnVIX', 'recFV48sYPeTYdmDD']],
    ['Vegan Dairy',   'Breakfast Base', 'Breakfast', 0, ['rec8QI7OleQoOILwO', 'rec8RoEQf6Ei4lzLV']],
    ['Egg',           'Breakfast Base', 'Breakfast', 0, ['recVHJbaeV6Dofueq']],

    // Starch swaps — replace-only in the UI (StarchSubstitutionSection)
    ['Starch Options', 'Starch Substitution', 'Lunch, Dinner', 0,
        ['rec4b9CN4MxAquLF0', 'rec1MmjWcS6Kw1cJ5', 'recLuswBMZWljd0SQ',
         'rec7MJSyWoVzosvg9', 'recda9SnRJ3aMd6mV']],

    // Veggie add-ons. Currently dead code in server.js (the variantVeggies block
    // is commented out) but the rows are here so re-enabling is a one-line change.
    ['Veggie Add-ons', 'Veggie Substitution', 'Lunch, Dinner', 0,
        ['recaQZdcLgl1QMqP7', 'rec81mQS6zzE4ktp0', 'rechRYTVZ6p7K8008', 'recu8baGyvWxPZVOq']],
];

// ===========================================================================
// CUSTOMERS (synthetic)
// ===========================================================================

const DELIVERY_DATES = ['2026-08-17', '2026-08-20'];

const CUSTOMERS = [
    {
        token: 'sf-demo-0001', first: 'Dana', last: 'Whitfield', email: 'dana.whitfield@example.com',
        goals: { cal: 1800, carb: 180, pro: 130, fat: 60, fib: 30 },
        notes: 'No pork, no shellfish', snacksPerDay: 1,
        plan: { Breakfast: 3, Lunch: 5, Dinner: 5, Snack: 2 },
    },
    {
        token: 'sf-demo-0002', first: 'Marcus', last: 'Oyelaran', email: 'marcus.o@example.com',
        goals: { cal: 2400, carb: 250, pro: 180, fat: 80, fib: 35 },
        notes: 'N/A', snacksPerDay: 2,
        plan: { Lunch: 5, Dinner: 5, Snack: 3 },
    },
    {
        token: 'sf-demo-0003', first: 'Priya', last: 'Raman', email: 'priya.raman@example.com',
        goals: { cal: 1600, carb: 160, pro: 110, fat: 55, fib: 32 },
        notes: 'Vegetarian, 2x sauce', snacksPerDay: 1,
        plan: { Breakfast: 5, Lunch: 3, Snack: 2 },
    },
    {
        token: 'sf-demo-0004', first: 'Elliot', last: 'Nakashima', email: 'elliot.n@example.com',
        goals: { cal: 2100, carb: 200, pro: 150, fat: 70, fib: 30 },
        notes: 'No dairy, no gluten, pescatarian', snacksPerDay: 0,
        plan: { Lunch: 4, Dinner: 4 },
    },
    {
        // Edge case worth keeping: a customer with a subscription but zero orders.
        // Exercises the early-return branch in the GET endpoint.
        token: 'sf-demo-0005', first: 'Rosa', last: 'Delgado', email: 'rosa.delgado@example.com',
        goals: { cal: 1900, carb: 190, pro: 140, fat: 65, fib: 28 },
        notes: 'New subscriber', snacksPerDay: 1,
        plan: { Lunch: 3, Dinner: 3 }, noOrders: true,
    },
];

// ===========================================================================
// WRITE
// ===========================================================================

let counter = 0;
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function recId(prefix = 'rec') {
    // Deterministic, Airtable-shaped: rec + 14 chars. Seeded runs are reproducible.
    counter += 1;
    let n = counter * 2654435761 % 1e14;
    let s = '';
    for (let i = 0; i < 14; i++) { s += ALPHA[n % ALPHA.length]; n = Math.floor(n / 7) + i * 31 + counter; }
    return prefix + s;
}

const insertIngredient = db.prepare(
    `INSERT INTO ingredients (id, ingredient_id, ingredient_name, usda_name, component)
     VALUES (?, ?, ?, ?, ?)`);
const insertDish = db.prepare(
    `INSERT INTO dishes (id, dish_id, type_of_meal) VALUES (?, ?, ?)`);
const insertDishIng = db.prepare(
    `INSERT INTO dish_ingredients (dish_pk, ingredient_id, sort_order) VALUES (?, ?, ?)`);
const insertMenu = db.prepare(
    `INSERT INTO weekly_menu
     (id, internal_dish_id, item_name, product_title, meals, status, exclude_from_subscriptions, image_url)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?)`);
const insertVariant = db.prepare(
    `INSERT INTO variants (id, variant_name, variant_type, applicable_to, price, availability)
     VALUES (?, ?, ?, ?, ?, 1)`);
const insertVariantIng = db.prepare(
    `INSERT INTO variant_ingredients (variant_id, ingredient_id) VALUES (?, ?)`);
const insertClient = db.prepare(
    `INSERT INTO clients (id, unique_id, first_name, last_name, email, meal, identifier,
        goal_calories, goal_carbs_g, goal_protein_g, goal_fat_g, goal_fiber_g, notes, snacks_per_day)
     VALUES (@id, @unique_id, @first_name, @last_name, @email, @meal, @identifier,
        @goal_calories, @goal_carbs_g, @goal_protein_g, @goal_fat_g, @goal_fiber_g, @notes, @snacks_per_day)`);
const insertSub = db.prepare(
    `INSERT INTO subscriptions (id, customer_name, meal, meals_included, next_delivery_date)
     VALUES (?, ?, ?, ?, ?)`);
const insertOrder = db.prepare(
    `INSERT INTO open_orders (id, order_subscription_id, quantity, source, item_name,
        selected_protein, squarespace_item_id, meal_portion, customer_name, delivery_date,
        dish_id, client_id, nutrition_notes, customer_edits, email, meal_sticker, order_placed_at)
     VALUES (@id, @order_subscription_id, 1, @source, @item_name, @selected_protein,
        @squarespace_item_id, @meal_portion, @customer_name, @delivery_date, @dish_id,
        @client_id, @nutrition_notes, '', @email, @meal_sticker, @order_placed_at)`);
const insertOrderIng = db.prepare(
    `INSERT OR IGNORE INTO order_ingredients (order_id, ingredient_id, kind, sort_order)
     VALUES (?, ?, ?, ?)`);

const ingByName = new Map();

const run = db.transaction(() => {
    for (const [id, code, name, component] of INGREDIENTS) {
        insertIngredient.run(id, code, name, name, component);
        ingByName.set(id, name);
    }

    // A dish row exists per (dishId, mealType) pairing, matching the Airtable
    // Dishes table which server.js queries with FIND(mealType, {Type of Meal}).
    const dishPkByKey = new Map();
    for (const d of DISHES) {
        const pk = recId();
        dishPkByKey.set(d.dishId, pk);
        insertDish.run(pk, d.dishId, d.meals.join(', '));
        d.ingredients.forEach((ing, i) => insertDishIng.run(pk, ing, i));

        // One weekly-menu row per meal type this dish is offered for.
        for (const meal of d.meals) {
            insertMenu.run(recId(), d.dishId, d.name, d.name, meal,
                `https://placehold.co/600x600/e8e4d9/3d3d3d?text=${encodeURIComponent(d.name)}`);
        }
    }

    for (const [name, type, applicable, price, ings] of VARIANTS) {
        const vid = recId();
        insertVariant.run(vid, name, type, applicable, price);
        for (const ing of ings) insertVariantIng.run(vid, ing);
    }

    let orderSeq = 5000;

    for (const c of CUSTOMERS) {
        const fullName = `${c.first} ${c.last}`;
        const clientIdByMeal = new Map();

        for (const meal of Object.keys(c.plan)) {
            const cid = recId();
            clientIdByMeal.set(meal, cid);
            insertClient.run({
                id: cid, unique_id: c.token, first_name: c.first, last_name: c.last,
                email: c.email, meal,
                identifier: `${fullName} | ${meal} | ${c.email}`,
                goal_calories: c.goals.cal, goal_carbs_g: c.goals.carb,
                goal_protein_g: c.goals.pro, goal_fat_g: c.goals.fat,
                goal_fiber_g: c.goals.fib, notes: c.notes, snacks_per_day: c.snacksPerDay,
            });

            for (const date of DELIVERY_DATES) {
                insertSub.run(recId(), fullName, meal, c.plan[meal], date);
            }
        }

        if (c.noOrders) continue;

        // Build orders: for each meal type, pick dishes offered for it and
        // create one row per serving across both delivery dates.
        for (const [meal, count] of Object.entries(c.plan)) {
            const eligible = DISHES.filter(d => d.meals.includes(meal));
            if (!eligible.length) continue;

            DELIVERY_DATES.forEach((date, dIdx) => {
                // Stagger which dishes each customer gets so the fixture isn't uniform.
                const take = Math.max(1, Math.min(count, eligible.length) - dIdx);
                for (let i = 0; i < take; i++) {
                    const dish = eligible[(i + dIdx + c.token.length) % eligible.length];
                    const oid = recId();
                    orderSeq += 1;

                    const protein = dish.ingredients.find(
                        x => INGREDIENTS.find(r => r[0] === x && r[3] === 'Meat'));

                    insertOrder.run({
                        id: oid,
                        order_subscription_id: String(orderSeq),
                        source: 'New Recommendation',
                        item_name: dish.name,
                        selected_protein: protein ? ingByName.get(protein) : '',
                        squarespace_item_id:
                            `${date.replace(/-/g, '').slice(2)}${c.first.toLowerCase()}${orderSeq}${meal.toLowerCase()}0${i + 1}`,
                        meal_portion: `${meal} Subscriptions`,
                        customer_name: fullName,
                        delivery_date: date,
                        dish_id: dish.dishId,
                        client_id: clientIdByMeal.get(meal),
                        nutrition_notes: c.notes,
                        email: c.email,
                        meal_sticker:
                            `${dish.name}: ${dish.ingredients.map(x => ingByName.get(x)).join(', ')}`,
                        order_placed_at: '2026-08-14',
                    });

                    dish.ingredients.forEach((ing, idx) =>
                        insertOrderIng.run(oid, ing, 'original', idx));
                }
            });
        }
    }

    // One customer with an actual saved customization, so the "final differs
    // from original" path has coverage without needing to click through the UI.
    const customized = db.prepare(
        `SELECT id FROM open_orders WHERE customer_name = 'Dana Whitfield'
           AND item_name = 'The Rainbow Bowl' LIMIT 1`).get();
    if (customized) {
        const orig = db.prepare(
            `SELECT ingredient_id, sort_order FROM order_ingredients
              WHERE order_id = ? AND kind = 'original' ORDER BY sort_order`).all(customized.id);
        // Swap salmon -> chicken, drop the tahini dressing.
        orig.forEach(r => {
            if (r.ingredient_id === 'reci3I0ppqDdY7E1q') return;
            const id = r.ingredient_id === 'recznARsvi4UC12bK' ? 'recuh74IVoEsaycHr' : r.ingredient_id;
            insertOrderIng.run(customized.id, id, 'final', r.sort_order);
        });
        db.prepare(
            `UPDATE open_orders
                SET customer_edits = ?, selected_protein = 'Grilled Chicken'
              WHERE id = ?`)
            .run('8/14/2026, 9:12:04 AM - Grilled Salmon replaced with Grilled Chicken;\n'
               + '8/14/2026, 9:12:31 AM - Tahini Dressing removed;\n', customized.id);
    }
});

run();

const counts = {};
for (const t of ['clients', 'ingredients', 'dishes', 'dish_ingredients', 'weekly_menu',
                 'subscriptions', 'variants', 'variant_ingredients', 'open_orders',
                 'order_ingredients']) {
    counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
}

console.log(`\nSeeded ${DB_PATH}\n`);
for (const [t, c] of Object.entries(counts)) {
    console.log(`  ${t.padEnd(22)} ${String(c).padStart(5)}`);
}
console.log('\nTokens:');
for (const c of CUSTOMERS) {
    console.log(`  ${c.token}  ${c.first} ${c.last}`
        + `${c.noOrders ? '  (subscribed, no orders — tests the empty branch)' : ''}`);
}
console.log(`\nTry:  http://localhost:3000/meal-plan?customer=${CUSTOMERS[0].token}\n`);

db.close();
