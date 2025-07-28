const express = require('express');
const { base } = require('./airtable');
const { sendWeeklyEmails } = require('./emailer');

const app = express();
app.use(express.json());

let CACHED_STANDARD_SAUCES = null;
let CACHED_INGREDIENT_COMPONENTS = {};

// Helper function to get ingredient name from ID
const getIngredientName = async (ingredientId) => {
    if (!ingredientId) return 'No Sauce';
    try {
        const ingredient = await base('Ingredients').find(ingredientId);
        return ingredient.fields['Ingredient ID'] ||
            ingredient.fields['Ingredient Name']
    } catch (err) {
        console.warn('Could not fetch ingredient name for ID:', ingredientId);
        return ingredientId;
    }
};

const getStandardSauces = async () => {
    if (CACHED_STANDARD_SAUCES) return CACHED_STANDARD_SAUCES;

    try {
        // Fetch all 3 standard sauces in one query
        const standardSauceRecords = await base('Ingredients').select({
            filterByFormula: `OR({Ingredient ID} = 'SF Vinegar & Oil', {Ingredient ID} = 'SF Citrus Vinaigrette', {Ingredient ID} = '9156 Lemon')`
        }).all();

        CACHED_STANDARD_SAUCES = standardSauceRecords.map(record => ({
            id: record.id,
            name: record.fields['Ingredient Name'] || record.fields['Name'] || 'Unknown',
            isActive: false
        }));

        // Add "No Sauce" option
        CACHED_STANDARD_SAUCES.push({ id: null, name: 'No Sauce', isActive: false });

        //console.log('🍶 Cached standard sauces:', CACHED_STANDARD_SAUCES.length);
        return CACHED_STANDARD_SAUCES;
    } catch (err) {
        console.warn('Could not cache standard sauces:', err.message);
        return [{ id: null, name: 'No Sauce', isActive: false }];
    }
};

// To decrease latency for sauces and starches
const cacheIngredientComponents = async (ingredientIds) => {
    const uncachedIds = ingredientIds.filter(id => !CACHED_INGREDIENT_COMPONENTS[id]);

    if (uncachedIds.length > 0) {
        const ingredientRecords = await base('Ingredients').select({
            filterByFormula: `OR(${uncachedIds.map(id => `RECORD_ID() = '${id}'`).join(',')})`,
            fields: ['Component']
        }).all();

        ingredientRecords.forEach(record => {
            CACHED_INGREDIENT_COMPONENTS[record.id] = record.fields['Component'];
        });
    }
};


const getSauceAndGarnishOptions = async (allIngredientIds, ingredientNames, ingredientComponents, currentIngredientIds, originalIngredientIds, mealType) => {

    //console.log('🍶 Getting sauce/garnish options for', allIngredientIds.length, 'ingredients');

    // Find current sauce ingredients using ONLY the currently active ingredients
    const currentSauceIngredients = currentIngredientIds
        .filter(id => ingredientComponents[id] === 'Sauce')
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: true
        }));

    // Find original sauce ingredients (to always show as options)
    const originalSauceIngredients = originalIngredientIds
        .filter(id => ingredientComponents[id] === 'Sauce')
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: Boolean(currentIngredientIds.includes(id)) // Only active if in current
        }));

    // Get cached standard sauces
    const standardSauces = await getStandardSauces();

    // Mark any standard sauces that are currently active
    const allSauceOptions = standardSauces.map(standardSauce => ({
        ...standardSauce,
        isActive: Boolean(currentSauceIngredients.some(current => current.id === standardSauce.id))
    }));

    // Add original sauces that aren't in the standard list
    originalSauceIngredients.forEach(originalSauce => {
        if (!allSauceOptions.some(option => option.id === originalSauce.id)) {
            allSauceOptions.unshift(originalSauce); // Add to beginning
        }
    });

    // Add any current sauces that aren't in original or standard (edge case)
    currentSauceIngredients.forEach(currentSauce => {
        if (!allSauceOptions.some(option => option.id === currentSauce.id)) {
            allSauceOptions.unshift(currentSauce);
        }
    });

    // Check if "No Sauce" should be active (no current sauce ingredients)
    const noSauceOption = allSauceOptions.find(option => option.id === null);
    if (noSauceOption) {
        noSauceOption.isActive = currentSauceIngredients.length === 0;
    }


    // Find ALL possible garnishes (from original + final) but mark correctly
    const garnishOptions = allIngredientIds
        .filter(id => ingredientComponents[id] === 'Garnish')
        .map(id => {
            const isActive = currentIngredientIds.includes(id);
            //console.log(`🌿 Garnish ${ingredientNames[id]} (${id}): ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
            return {
                id,
                name: ingredientNames[id] || id,
                isActive: Boolean(isActive)
            };
        });

    //console.log('🌿 Final garnish options:', garnishOptions);

    const veggieStarchOptions = await getVeggieStarchOptions(allIngredientIds, ingredientNames, ingredientComponents, currentIngredientIds, originalIngredientIds, mealType);


    return {
        sauceOptions: allSauceOptions,
        garnishOptions: garnishOptions,
        veggieOptions: veggieStarchOptions.veggieOptions,
        starchOptions: veggieStarchOptions.starchOptions
    };
};

let CACHED_VARIANTS = null;

const getCachedVariants = async () => {
    if (CACHED_VARIANTS) return CACHED_VARIANTS;

    try {
        console.log('📦 Caching all variants...');
        const allVariants = await base('Variants').select({
            filterByFormula: `{Availability} = TRUE()`
        }).all();

        CACHED_VARIANTS = allVariants;
        console.log(`📦 Cached ${allVariants.length} variants`);
        return allVariants;
    } catch (err) {
        console.warn('Could not cache variants:', err.message);
        return [];
    }
};

const getCurrentProteinId = (currentIngredients, ingredientComponents) => {
    for (const ingredientId of currentIngredients) {
        if (ingredientComponents[ingredientId] === 'Meat') {
            return ingredientId;
        }
    }
    return null;
};

const getProteinOptionsForOrder = async (currentProteinId, mealType) => {
    if (!currentProteinId) return { options: [], currentProtein: null };

    try {
        // Get current protein info
        const currentProteinRecord = await base('Ingredients').find(currentProteinId);
        const currentProteinIngredient = {
            id: currentProteinId,
            name: currentProteinRecord.fields['Ingredient Name'] || currentProteinRecord.fields['USDA Name'] || 'Unknown',
        };

        // Get cached variants (already cached)
        const allVariants = await getCachedVariants();

        // Find variant type for current protein
        let relevantVariantType = null;
        for (const variant of allVariants) {
            const variantIngredients = variant.fields['Ingredient'] || [];
            if (variantIngredients.includes(currentProteinId)) {
                relevantVariantType = variant.fields['Variant Type'];
                break;
            }
        }

        if (!relevantVariantType) {
            return { options: [], currentProtein: currentProteinIngredient };
        }

        // Get substitutions for this meal type
        const proteinSubstitutions = allVariants.filter(variant => {
            const variantType = variant.fields['Variant Type'];
            const applicableTo = variant.fields['Applicable to'] || '';
            return variantType === relevantVariantType && applicableTo.includes(mealType);
        });

        // Build options list
        const proteinOptions = [];
        for (const variant of proteinSubstitutions) {
            const variantIngredientIds = variant.fields['Ingredient'] || [];
            for (const ingredientId of variantIngredientIds) {
                try {
                    const ingredient = await base('Ingredients').find(ingredientId);
                    proteinOptions.push({
                        id: ingredientId,
                        name: ingredient.fields['Ingredient Name'] || ingredient.fields['USDA Name'] || 'Unknown',
                        variantName: variant.fields['Variant Name'],
                        price: variant.fields['Price'] || 0, // Added for +4 protein
                        isActive: Boolean(ingredientId === currentProteinId),
                        displayName: ingredient.fields['Ingredient Name'] === 'Egg'
                            ? `${ingredient.fields['Ingredient Name']} ${variant.fields['Variant Name']}`
                            : ingredient.fields['Ingredient Name']
                    });
                } catch (err) {
                    console.warn('Could not fetch protein ingredient:', ingredientId);
                }
            }
        }

        return {
            currentProtein: currentProteinIngredient,
            options: proteinOptions
        };

    } catch (error) {
        console.error('Error getting protein options:', error);
        return { options: [], currentProtein: null };
    }
};

const getVeggieStarchOptions = async (allIngredientIds, ingredientNames, ingredientComponents, currentIngredientIds, originalIngredientIds, mealType) => {
    //console.log('🥕 Getting veggie/starch options for meal type:', mealType);

    // Step 1: Find current veggies (mark green)
    const currentVeggies = currentIngredientIds
        .filter(id => ingredientComponents[id] === 'Veggies')
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: true,
            source: 'current'
        }));

    // Step 2: Find original veggies that aren't current (mark gray)
    const originalVeggies = originalIngredientIds
        .filter(id => ingredientComponents[id] === 'Veggies' && !currentIngredientIds.includes(id))
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: false,
            source: 'original'
        }));

    // Step 3: Get variant veggies for this meal
    const allVariants = await getCachedVariants();
    // const variantVeggies = [];

    // for (const variant of allVariants) {
    //     const variantType = variant.fields['Variant Type'];
    //     const applicableTo = variant.fields['Applicable to'] || '';
    //     const variantIngredients = variant.fields['Ingredient'] || [];

    //     if (!applicableTo.includes(mealType) || variantType !== 'Veggie Substitution') continue;

    //     for (const ingredientId of variantIngredients) {
    //         const ingredientName = ingredientNames[ingredientId];
    //         if (ingredientName) {
    //             variantVeggies.push({
    //                 id: ingredientId,
    //                 name: ingredientName,
    //                 isActive: Boolean(currentIngredientIds.includes(ingredientId)),
    //                 source: 'variant'
    //             });
    //         }
    //     }
    // }

    // Step 4: Combine all, removing duplicates (prioritize current > original > variant)
    const allVeggieIds = new Set();
    const finalVeggieOptions = [];

    // Add current veggies first
    currentVeggies.forEach(veggie => {
        allVeggieIds.add(veggie.id);
        finalVeggieOptions.push(veggie);
    });

    // Add original veggies if not already added
    originalVeggies.forEach(veggie => {
        if (!allVeggieIds.has(veggie.id)) {
            allVeggieIds.add(veggie.id);
            finalVeggieOptions.push(veggie);
        }
    });

    // Add variant veggies if not already added
    // variantVeggies.forEach(veggie => {
    //     if (!allVeggieIds.has(veggie.id)) {
    //         allVeggieIds.add(veggie.id);
    //         finalVeggieOptions.push(veggie);
    //     }
    // });

    // console.log(`🥕 Final veggie options: ${finalVeggieOptions.length}`);
    // console.log('🥕 Current (green):', currentVeggies.map(v => v.name));
    // console.log('🥕 Original (gray):', originalVeggies.map(v => v.name));
    // console.log('🥕 Variants (gray):', variantVeggies.filter(v => !currentIngredientIds.includes(v.id)).map(v => v.name));

    // Step 5: Do the same for starch (but starch is replace-only, like sauce)
    const currentStarch = currentIngredientIds
        .filter(id => ingredientComponents[id] === 'Starch')
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: true,
            source: 'current'
        }));

    const originalStarch = originalIngredientIds
        .filter(id => ingredientComponents[id] === 'Starch' && !currentIngredientIds.includes(id))
        .map(id => ({
            id,
            name: ingredientNames[id] || id,
            isActive: false,
            source: 'original'
        }));

    // Get variant starch for this meal
    const variantStarch = [];

    for (const variant of allVariants) {
        const variantType = variant.fields['Variant Type'];
        const applicableTo = variant.fields['Applicable to'] || '';
        const variantIngredients = variant.fields['Ingredient'] || [];

        if (!applicableTo.includes(mealType) || variantType !== 'Starch Substitution') continue;

        for (const ingredientId of variantIngredients) {
            const ingredientName = ingredientNames[ingredientId];
            if (ingredientName) {
                variantStarch.push({
                    id: ingredientId,
                    name: ingredientName,
                    isActive: Boolean(currentIngredientIds.includes(ingredientId)),
                    source: 'variant'
                });
            }
        }
    }

    // Combine starch options (same deduplication logic)
    const allStarchIds = new Set();
    const finalStarchOptions = [];

    currentStarch.forEach(starch => {
        allStarchIds.add(starch.id);
        finalStarchOptions.push(starch);
    });

    originalStarch.forEach(starch => {
        if (!allStarchIds.has(starch.id)) {
            allStarchIds.add(starch.id);
            finalStarchOptions.push(starch);
        }
    });

    variantStarch.forEach(starch => {
        if (!allStarchIds.has(starch.id)) {
            allStarchIds.add(starch.id);
            finalStarchOptions.push(starch);
        }
    });

    //console.log(`🍞 Final starch options: ${finalStarchOptions.length}`);

    return {
        veggieOptions: finalVeggieOptions,
        starchOptions: finalStarchOptions  // TODO: implement starch with same logic
    };
};

// Add CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});


// PATCH endpoint - update customer orders with nutrition validation
app.patch('/api/orders/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const { updates } = req.body;

        //console.log('PATCH request received for token:', token);

        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ error: 'Invalid updates format' });
        }

        // Verify customer exists
        const customerRecords = await base('Open Orders').select({
            // filterByFormula: `ARRAYJOIN({Unique ID (from To_Match_Client_Nutrition)}, "") = '${token}'`,
            filterByFormula: `SEARCH('${token}', ARRAYJOIN({To_Match_Client_Nutrition}, "")) > 0`,

            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Simple batch update - only quantity changes
        const airtableUpdates = updates
            .filter(update => update.quantityDelta !== 0)
            .map(update => ({
                id: update.recordId,
                fields: {
                    'Quantity': parseInt(update.newQuantity) || 0
                }
            }));

        if (airtableUpdates.length === 0) {
            return res.json({
                success: true,
                updatedCount: 0,
                message: 'No changes to update'
            });
        }

        // Update records in Airtable
        const updatedRecords = await base('Open Orders').update(airtableUpdates);
        //console.log('Successfully updated', updatedRecords.length, 'records');

        res.json({
            success: true,
            updatedCount: updatedRecords.length,
            message: `Successfully updated ${updatedRecords.length} order(s)`
        });

    } catch (error) {
        console.error('Error updating orders:', error);
        res.status(500).json({
            error: 'Failed to update orders',
            details: error.message
        });
    }
});


// Toggle veggie endpoint
app.patch('/api/orders/:token/toggle-veggie', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, veggieId, shouldActivate } = req.body;

        //console.log('🥕 Toggling veggie:', veggieId, shouldActivate ? 'ON' : 'OFF');

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // Toggle the veggie
        let updatedIngredientIds;
        if (shouldActivate) {
            // Add veggie if not already active
            updatedIngredientIds = currentIngredientIds.includes(veggieId)
                ? currentIngredientIds
                : [...currentIngredientIds, veggieId];
        } else {
            // Remove veggie
            updatedIngredientIds = currentIngredientIds.filter(id => id !== veggieId);
        }

        const customerEdits = orderRecord.fields['Customer Edits'] || '';

        // Get ingredient name for logging
        const ingredientName = await getIngredientName(veggieId);

        // Update Final Ingredients with User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + ingredientName + ' ' + (shouldActivate ? 'added' : 'removed') + ';\n'
            }
        }]);

        res.json({
            success: true,
            message: `Veggie ${shouldActivate ? 'added' : 'removed'}`,
            updatedIngredientIds: updatedIngredientIds
        });

    } catch (error) {
        console.error('❌ Error toggling veggie:', error);
        res.status(500).json({
            error: 'Failed to toggle veggie',
            details: error.message
        });
    }
});

// Replace starch endpoint  
app.patch('/api/orders/:token/toggle-starch', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, starchId, shouldActivate } = req.body;

        //console.log('🍞 Toggling starch:', starchId, shouldActivate ? 'ON' : 'OFF');

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // Remove all current starch ingredients
        // const updatedIngredientIds = [];
        // for (const ingredientId of currentIngredientIds) {
        //     try {
        //         const ingredient = await base('Ingredients').find(ingredientId);
        //         if (ingredient.fields['Component'] !== 'Starch') {
        //             updatedIngredientIds.push(ingredientId); // Keep non-starch ingredients
        //         }
        //     } catch (err) {
        //         updatedIngredientIds.push(ingredientId); // Keep if can't check component
        //     }
        // }
        // Cache components for all ingredients first
        await cacheIngredientComponents(currentIngredientIds);

        // Now filter without API calls
        const updatedIngredientIds = currentIngredientIds.filter(id =>
            CACHED_INGREDIENT_COMPONENTS[id] !== 'Starch'
        );


        // Add new starch
        updatedIngredientIds.push(starchId);

        //console.log('🍞 Updated ingredients:', updatedIngredientIds);

        const customerEdits = orderRecord.fields['Customer Edits'] || '';

        // Get ingredient name for logging
        const ingredientName = await getIngredientName(starchId);

        // Update Final Ingredients with User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + ingredientName + ' ' + (shouldActivate ? 'added' : 'removed') + ';\n'
            }
        }]);

        res.json({
            success: true,
            message: 'Starch updated successfully',
            updatedIngredientIds: updatedIngredientIds
        });

    } catch (error) {
        console.error('❌ Error toggling starch:', error);
        res.status(500).json({
            error: 'Failed to toggle starch',
            details: error.message
        });

    }
});

// GET endpoint - get nutrition summary for a customer
app.get('/api/nutrition/:token', async (req, res) => {
    try {
        const token = req.params.token;

        // This would calculate detailed nutrition breakdown
        // Implementation depends on your meal nutrition data structure

        res.json({ message: 'Nutrition endpoint - to be implemented' });
    } catch (error) {
        console.error('Error fetching nutrition data:', error);
        res.status(500).json({ error: 'Failed to fetch nutrition data' });
    }
});

// POST endpoint - send weekly emails
app.post('/api/send-emails', async (req, res) => {
    try {
        await sendWeeklyEmails();
        res.json({ status: 'Emails sent successfully' });
    } catch (error) {
        console.error('Error sending emails:', error);
        res.status(500).json({ error: 'Failed to send emails' });
    }
});


app.get('/api/orders/:token', async (req, res) => {
    console.log('🚨 API REQUEST RECEIVED:', req.params.token);

    // req.setTimeout(25000, () => {
    //     res.status(408).json({ error: 'Request timeout - try refreshing' });
    // });

    try {
        const token = req.params.token;
        //console.log('Fetching orders for token:', token);

        // Step 1: Find the customer record first (with filtering to reduce data)
        const customerRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            //console.log('Customer not found for token:', token);
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customerRecord = customerRecords[0];
        console.log('Found customer:', customerRecord.fields.First_Name, customerRecord.fields.Last_Name);

        // Step 2: Get client nutrition profile using the identifier
        const clientIdentifier = customerRecord.fields['identifier'];

        // Extract email from the identifier format: "Name | Meal | email@domain.com"
        const customerName = customerRecord.fields['First_Name'] + ' ' + customerRecord.fields['Last_Name'];
        const customerEmail = customerRecord.fields['TypyForm_Email'];

        console.log('Customer details:', {
            name: customerName,
            email: customerEmail,
            identifier: clientIdentifier
        });

        // console.log('🔍 Searching for ALL client records for email:', customerEmail);

        const allClientRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`
        }).all();

        console.log('🔍 Found', allClientRecords.length, 'client records for this customer:');
        allClientRecords.forEach((record, i) => {
            console.log(`   ${i + 1}. Meal: ${record.fields['Meal']}, Identifier: ${record.fields['identifier']}`);
        });

        // Use the first client record for goals (they should have same nutrition goals)
        const clientProfile = allClientRecords[0];

        if (!clientProfile) {
            return res.status(400).json({
                error: 'Client nutrition profile not found',
                debug: { clientIdentifier, customerEmail }
            });
        }

        console.log('Using client profile for:', clientProfile.fields['First_Name'], clientProfile.fields['Last_Name'], '- Meal:', clientProfile.fields['Meal']);

        // Step 3: Get orders from ALL client records (combine all meal types)
        const orderRecords = await base('Open Orders').select({
            filterByFormula: `ARRAYJOIN({Unique ID (from To_Match_Client_Nutrition)}, "") = '${token}'`,
        }).all();

        const orderToMealTypeMap = {}


        if (!orderRecords.length) {
            return res.json({
                customer: {
                    name: customerRecord.fields.First_Name + ' ' + customerRecord.fields.Last_Name,
                    email: customerRecord.fields.Email
                },
                nutritionGoals: {
                    calories: clientProfile.fields['goal_calories'] || 0,
                    carbs: clientProfile.fields['goal_carbs(g)'] || 0,
                    protein: clientProfile.fields['goal_protein(g)'] || 0,
                    fat: clientProfile.fields['goal_fat(g)'] || 0,
                    fiber: clientProfile.fields['goal_fiber(g)'] || 0,
                    // allergies: clientProfile.fields['Allergies_Diet'] || [],
                    notes: clientProfile.fields['Notes'] || '',
                    snacksPerDay: clientProfile.fields['# of snacks per day'] || 0
                },
                currentTotals: { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 },
                orders: [],
                summary: { totalMeals: 0, calorieProgress: 0 }
            });
        }

        console.log('Successfully loaded', orderRecords.length, 'order records');

        // Step 6: Format response with nutrition awareness AND INGREDIENTS
        // Step 5: Get unique ingredient record IDs to resolve names
        const ingredientRecordIds = new Set();
        orderRecords.forEach(r => {
            // Collect ingredient IDs from both Original and Final Ingredients with User Edits
            if (r.fields['Final Ingredients After User Edits']) {
                r.fields['Final Ingredients After User Edits'].forEach(id => ingredientRecordIds.add(id));
            }
            if (r.fields['Original Ingredients']) {
                r.fields['Original Ingredients'].forEach(id => ingredientRecordIds.add(id));
            }
            orderToMealTypeMap[r.id] = r.fields['Meal Portion'];
        });

        // Step 6: Fetch ingredient names from Ingredients table + ALL variant ingredients
        const ingredientNames = {};
        const ingredientComponents = {};

        // First, get all variant ingredient IDs for this customer's meal types
        const customerMealTypes = [...new Set(Object.values(orderToMealTypeMap))];
        console.log('🔍 Customer meal types:', customerMealTypes);

        const allVariantsForMeals = await getCachedVariants();
        const variantIngredientIds = new Set();

        allVariantsForMeals.forEach(variant => {
            const applicableTo = variant.fields['Applicable to'] || '';
            const variantType = variant.fields['Variant Type'];

            // Only get variants that apply to this customer's meals
            const appliesToCustomerMeals = customerMealTypes.some(mealType => applicableTo.includes(mealType));

            if (appliesToCustomerMeals && (variantType === 'Veggie Substitution' || variantType === 'Starch Substitution')) {

                const variantIngredients = variant.fields['Ingredient'] || [];
                variantIngredients.forEach(id => variantIngredientIds.add(id));
            }
        });

        console.log('🔍 Found', variantIngredientIds.size, 'variant ingredients to fetch');

        // Combine order ingredients + variant ingredients
        const allIngredientIdsToFetch = new Set([...ingredientRecordIds, ...variantIngredientIds]);

        if (allIngredientIdsToFetch.size > 0) {
            try {
                console.log('Fetching ingredient names for', allIngredientIdsToFetch.size, 'ingredients (orders + variants)');

                // Fetch in batches if too many
                const ingredientIdArray = Array.from(allIngredientIdsToFetch);
                const batchSize = 100;

                for (let i = 0; i < ingredientIdArray.length; i += batchSize) {
                    const batch = ingredientIdArray.slice(i, i + batchSize);

                    const ingredientRecords = await base('Ingredients').select({
                        filterByFormula: `OR(${batch.map(id => `RECORD_ID() = '${id}'`).join(',')})`,
                        maxRecords: batchSize
                    }).all();

                    ingredientRecords.forEach(record => {
                        const ingredientName = record.fields['Ingredient Name'] ||
                            record.fields['Name'] ||
                            record.fields['USDA Name'] ||
                            'Unknown Ingredient';

                        ingredientNames[record.id] = ingredientName;
                        ingredientComponents[record.id] = record.fields['Component'];
                    });
                }

                console.log('Resolved ingredient names:', Object.keys(ingredientNames).length, 'ingredients');
                console.log('🥕 Veggie variants loaded:', Object.keys(ingredientComponents).filter(id => ingredientComponents[id] === 'Veggies').length);
            } catch (err) {
                console.warn('Could not fetch ingredient names:', err.message);
            }
        }

        //STEP pre-7: sauce and garnish

        const optionsCache = {};
        const proteinOptionsCache = {};
        // const imageCache = {};
        console.log('🖼️ Batch fetching all images...');
        const uniqueDishIds = [...new Set(orderRecords.map(r => r.fields['Dish ID']).filter(Boolean))];
        console.log(`🖼️ Found ${uniqueDishIds.length} unique dish IDs`);

        const imageLookup = {};
        if (uniqueDishIds.length > 0) {
            try {
                const imageRecords = await base('Products/ Weekly Menu').select({
                    filterByFormula: `OR(${uniqueDishIds.map(id => `{Internal Dish ID} = ${id}`).join(',')})`,
                    fields: ['Internal Dish ID', 'Product Title', 'Images (view only)']
                }).all();

                imageRecords.forEach(record => {
                    const dishId = record.fields['Internal Dish ID'];
                    const imageField = record.fields['Images (view only)'];
                    if (imageField && imageField[0]) {
                        imageLookup[dishId] = imageField[0].thumbnails?.large?.url || imageField[0].url;
                    }
                });

                console.log(`🖼️ ✅ Cached ${Object.keys(imageLookup).length} images`);
            } catch (err) {
                console.warn('❌ Batch image fetch failed:', err.message);
            }
        }


        // Step 7: Format response with RESOLVED INGREDIENTS
        const orders = await Promise.all(orderRecords.map(async (r) => {
            const originalIngredientIds = r.fields['Original Ingredients'] || [];
            const finalIngredientIds = r.fields['Final Ingredients After User Edits'] || [];
            const currentIngredientIds = finalIngredientIds.length > 0 ? finalIngredientIds : originalIngredientIds;
            const ingredientsList = currentIngredientIds.map(id => ingredientNames[id] || id).filter(Boolean);


            const allIngredientIds = [...new Set([...originalIngredientIds, ...currentIngredientIds])];
            const allIngredients = allIngredientIds.map(id => ({
                id,
                name: ingredientNames[id] || id
            }));

            // NEW: Get sauce and garnish options
            const mealType = orderToMealTypeMap[r.id] || 'Snack';
            const cacheKey = `${mealType}-${currentIngredientIds.join(',')}`;

            let sauceAndGarnishOptions = optionsCache[cacheKey];
            if (!sauceAndGarnishOptions) {
                sauceAndGarnishOptions = await getSauceAndGarnishOptions(allIngredientIds, ingredientNames, ingredientComponents, currentIngredientIds, originalIngredientIds, mealType);
                optionsCache[cacheKey] = sauceAndGarnishOptions;
            }

            const currentProteinId = getCurrentProteinId(currentIngredientIds, ingredientComponents);
            const proteinCacheKey = `${currentProteinId}-${mealType}`;

            let proteinOptions = proteinOptionsCache[proteinCacheKey];
            if (!proteinOptions && currentProteinId) {
                proteinOptions = await getProteinOptionsForOrder(currentProteinId, mealType);
                proteinOptionsCache[proteinCacheKey] = proteinOptions;
            }


            const imageUrl = imageLookup[r.fields['Dish ID']] || null;





            return {
                recordId: r.id,
                itemName: r.fields['Airtable ItemName'] || 'Unknown Item',
                quantity: r.fields['Quantity'] || 0,
                email: r.fields['Email'] || customerRecord.fields['Email'],
                orderSubscriptionId: r.fields['Order/ Subscription ID'],
                meal: orderToMealTypeMap[r.id] || 'Snack',
                nutritionNotes: r.fields['Nutrition Notes'] || '',

                // INGREDIENTS
                originalIngredients: originalIngredientIds,
                finalIngredients: finalIngredientIds,
                ingredients: ingredientsList,
                hasCustomIngredients: finalIngredientIds.length > 0,

                allIngredients: allIngredients,


                // NEW: Add sauce and garnish options
                sauceOptions: sauceAndGarnishOptions.sauceOptions,
                garnishOptions: sauceAndGarnishOptions.garnishOptions,

                veggieOptions: sauceAndGarnishOptions.veggieOptions,
                starchOptions: sauceAndGarnishOptions.starchOptions,



                // Nutrition
                calories: r.fields['Calories'] || 150,
                carbs: r.fields['Carbs'] || 15,
                protein: r.fields['Protein'] || 5,
                fat: r.fields['Fat'] || 8,
                fiber: r.fields['Fiber'] || 3,

                // allergies: (r.fields['Allergies_Diet'] || []).map(id => allergyNames[id] || id).filter(Boolean),


                proteinOptions: proteinOptions || { options: [], currentProtein: null },
                imageUrl: imageUrl

                // ✅ Add image
                //imageUrl
            };
        }));


        // Step 7: Include client nutrition goals and restrictions
        const clientGoals = {
            calories: clientProfile.fields['goal_calories'] || 0,
            carbs: clientProfile.fields['goal_carbs(g)'] || 0,
            protein: clientProfile.fields['goal_protein(g)'] || 0,
            fat: clientProfile.fields['goal_fat(g)'] || 0,
            fiber: clientProfile.fields['goal_fiber(g)'] || 0,
            // Resolve client allergies to readable names
            // allergies: (clientProfile.fields['Allergies_Diet'] || []).map(id => allergyNames[id] || id).filter(Boolean),
            notes: clientProfile.fields['Notes'] || '',
            snacksPerDay: clientProfile.fields['# of snacks per day'] || 0
        };

        // Calculate current nutrition totals
        const currentTotals = orders.reduce((totals, order) => ({
            calories: totals.calories + (order.calories * order.quantity),
            carbs: totals.carbs + (order.carbs * order.quantity),
            protein: totals.protein + (order.protein * order.quantity),
            fat: totals.fat + (order.fat * order.quantity),
            fiber: totals.fiber + (order.fiber * order.quantity)
        }), { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 });

        const response = {
            customer: {
                name: customerRecord.fields.First_Name + ' ' + customerRecord.fields.Last_Name,
                email: customerEmail
            },
            nutritionGoals: clientGoals,
            currentTotals: currentTotals,
            orders: orders,
            summary: {
                totalMeals: orders.length,
                calorieProgress: clientGoals.calories > 0 ? (currentTotals.calories / clientGoals.calories * 100).toFixed(1) : 0
            }
        };

        // console.log('🔍 Customer meal types:', customerMealTypes);
        // console.log('🔍 Total variants:', allVariantsForMeals.length);
        // console.log('🔍 Variant ingredient IDs to fetch:', variantIngredientIds.size);
        // console.log('🔍 Combined with order ingredients:', allIngredientIdsToFetch.size);


        // console.log('Returning optimized response with', orders.length, 'orders and ingredients');


        // res.setHeader('Content-Type', 'application/json');
        // res.setHeader('Content-Length', JSON.stringify(response).length);

        // res.writeHead(200, { 'Content-Type': 'application/json' });
        // res.end(JSON.stringify(response));



        // console.log('🎯 About to send response...');
        // console.log('Response size:', JSON.stringify(response).length);
        // console.log('Response keys:', Object.keys(response));




        res.json(response);
        console.log('✅ Response sent successfully!');

    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});


app.patch('/api/orders/:token/replace-protein', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, newProteinId, oldProteinId, upgradePrice = 0 } = req.body;

        console.log('🥩 Replacing protein:', oldProteinId, '->', newProteinId, upgradePrice > 0 ? `(+$${upgradePrice})` : '');

        // Verify customer exists
        const customerRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        // Use Final Ingredients with User Edits if exists, otherwise copy from Original
        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // Replace old protein with new protein
        const updatedIngredientIds = currentIngredientIds.map(id =>
            id === oldProteinId ? newProteinId : id
        );

        console.log('🥩 Updated ingredients:', updatedIngredientIds);

        const customerEdits = orderRecord.fields['Customer Edits'] || '';

        // Get ingredient names for logging
        const oldProteinName = await getIngredientName(oldProteinId);
        const newProteinName = await getIngredientName(newProteinId);

        // Create log entry with price info
        const logEntry = upgradePrice > 0
            ? `${oldProteinName} upgraded to ${newProteinName} (+$${upgradePrice} premium)`
            : `${oldProteinName} replaced with ${newProteinName}`;

        // Update Final Ingredients with User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + logEntry + ';\n'
            }
        }]);

        res.json({
            success: true,
            message: upgradePrice > 0
                ? `Protein upgraded to ${newProteinName} (+$${upgradePrice})`
                : `Protein updated to ${newProteinName}`,
            updatedIngredientIds: updatedIngredientIds,
            upgradePrice: upgradePrice
        });

    } catch (error) {
        console.error('❌ Error replacing protein:', error);
        res.status(500).json({
            error: 'Failed to replace protein',
            details: error.message
        });
    }
});


// NEW ENDPOINT - Toggle ingredients (add/remove)
app.patch('/api/orders/:token/ingredients/toggle', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, ingredientName, shouldActivate } = req.body;

        console.log('🔄 Toggling ingredient:', ingredientName, shouldActivate ? 'ON' : 'OFF');

        // Verify customer exists
        const customerRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get the current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        // Get current active ingredients (final if exists, otherwise original)
        const currentActiveIds = finalIngredientIds.length > 0 ? finalIngredientIds : [...originalIngredientIds];

        // Find the ingredient ID for the name
        const allIngredientIds = [...new Set([...originalIngredientIds, ...currentActiveIds])];
        const ingredientPromises = allIngredientIds.map(async (id) => {
            try {
                const ingredientRecord = await base('Ingredients').find(id);
                const name = ingredientRecord.fields['Ingredient Name'] ||
                    ingredientRecord.fields['Name'] ||
                    ingredientRecord.fields['USDA Name'] || 'Unknown';
                return { id, name };
            } catch (err) {
                return { id, name: id };
            }
        });

        const allIngredients = await Promise.all(ingredientPromises);
        const targetIngredient = allIngredients.find(ing =>
            ing.name.toLowerCase().includes(ingredientName.toLowerCase())
        );

        if (!targetIngredient) {
            return res.status(404).json({ error: 'Ingredient not found' });
        }

        // Toggle the ingredient
        let updatedIngredientIds;
        if (shouldActivate) {
            // Add ingredient if not already active
            updatedIngredientIds = currentActiveIds.includes(targetIngredient.id)
                ? currentActiveIds
                : [...currentActiveIds, targetIngredient.id];
        } else {
            // Remove ingredient
            updatedIngredientIds = currentActiveIds.filter(id => id !== targetIngredient.id);
        }

        // Update Final Ingredients with User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds
            }
        }]);

        // Return updated state
        const activeIngredients = updatedIngredientIds.map(id => {
            const ingredient = allIngredients.find(ing => ing.id === id);
            return ingredient ? ingredient.name : id;
        });

        res.json({
            success: true,
            message: `Ingredient "${ingredientName}" ${shouldActivate ? 'added' : 'removed'}`,
            activeIngredients: activeIngredients,
            finalIngredientIds: updatedIngredientIds,
            allIngredients: allIngredients.map(ing => ({ name: ing.name, id: ing.id }))
        });

    } catch (error) {
        console.error('❌ Error toggling ingredient:', error);
        res.status(500).json({
            error: 'Failed to toggle ingredient',
            details: error.message
        });
    }
});

app.patch('/api/orders/:token/ingredients', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, ingredientToDelete } = req.body;

        console.log('Deleting ingredient:', ingredientToDelete, 'from order:', recordId);

        // Verify customer exists
        const customerRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get the current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Get current ingredient IDs (linked records) - PRIORITIZE Final Ingredients after User Edits
        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        // Use Final Ingredients after User Edits if exists, otherwise copy from Original to start customization
        let currentIngredientIds;
        if (finalIngredientIds.length > 0) {
            currentIngredientIds = finalIngredientIds;
            console.log('Using existing Final Ingredients After User Edits:', currentIngredientIds);
        } else {
            currentIngredientIds = [...originalIngredientIds]; // Copy original to start customizing
            console.log('Copying Original to Final Ingredients After User Edits:', currentIngredientIds);
        }

        // Find which ingredient ID corresponds to the name we want to delete
        const ingredientPromises = currentIngredientIds.map(async (id) => {
            try {
                const ingredientRecord = await base('Ingredients').find(id);
                const ingredientName = ingredientRecord.fields['Ingredient Name'] ||
                    ingredientRecord.fields['Name'] ||
                    ingredientRecord.fields['USDA Name'] ||
                    'Unknown';
                return { id, name: ingredientName };
            } catch (err) {
                console.warn('Could not find ingredient:', id);
                return { id, name: id }; // Fallback to ID
            }
        });

        const ingredientsWithNames = await Promise.all(ingredientPromises);
        console.log('Current ingredients with names:', ingredientsWithNames);

        // Remove the ingredient that matches the name (case-insensitive partial match)
        const updatedIngredientIds = ingredientsWithNames
            .filter(ingredient =>
                !ingredient.name.toLowerCase().includes(ingredientToDelete.toLowerCase())
            )
            .map(ingredient => ingredient.id);

        console.log('Updated ingredient IDs:', updatedIngredientIds);
        const customerEdits = orderRecord.fields['Customer Edits'] || '';
        // Update the Final Ingredients after User Edits field with the modified list of IDs
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + ingredientName + ' ' + (shouldActivate ? 'added' : 'removed') + ';\n'
            }
        }]);

        console.log('Successfully updated Final Ingredients after User Edits in Airtable');

        // Return updated ingredient names for frontend
        const updatedIngredientNames = ingredientsWithNames
            .filter(ingredient =>
                !ingredient.name.toLowerCase().includes(ingredientToDelete.toLowerCase())
            )
            .map(ingredient => ingredient.name);

        res.json({
            success: true,
            message: `Ingredient "${ingredientToDelete}" removed successfully`,
            updatedIngredients: updatedIngredientNames,
            updatedIngredientIds: updatedIngredientIds
        });

    } catch (error) {
        console.error('Error deleting ingredient:', error);
        res.status(500).json({
            error: 'Failed to delete ingredient',
            details: error.message
        });
    }
});

app.patch('/api/orders/:token/quantity', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, newQuantity, itemName } = req.body;

        // Verify customer exists
        const customerRecords = await base('Client').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        console.log('🔄 Updating quantity for:', customerRecords[0].fields.First_Name + ' ' + customerRecords[0].fields.Last_Name, itemName, 'to', newQuantity);

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const customerEdits = orderRecord.fields['Customer Edits'] || '';
        const oldQuantity = orderRecord.fields['Quantity'] || 0;
        if (oldQuantity > 0) {
            await base('Open Orders').create([{
                fields: {
                    'Order/ Subscription ID': orderRecord.fields['Order/ Subscription ID'],
                    'Quantity': 1,
                    'Source': 'Subscription Landing Page',
                    'Selected Protein': orderRecord.fields['Selected Protein'],
                    'SquareSpace/ Internal OrderItem ID': orderRecord.fields['SquareSpace/ Internal OrderItem ID'],
                    'Meal Portion': orderRecord.fields['Meal Portion'],
                    'To_Match_Client_Nutrition': orderRecord.fields['To_Match_Client_Nutrition'],
                    'Airtable ItemName': orderRecord.fields['Airtable ItemName'],
                    'Order Placed/ Algo Ran At': new Date().toISOString().split('T')[0],
                    'Delivery Date': orderRecord.fields['Delivery Date'],
                    'Dish ID': orderRecord.fields['Dish ID'],
                    'Final Ingredients After User Edits': orderRecord.fields['Final Ingredients After User Edits'],
                    'Run LLM Review& Subsitutions': true,
                    'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + itemName + ' quantity updated from ' + oldQuantity + ' to ' + newQuantity + ';\n'
                }
            }]);


            console.log('✅ Successfully updated quantity');

            res.json({
                success: true,
                message: `Updated ${itemName} quantity from ${oldQuantity} to ${newQuantity}`,
                recordId: recordId,
                newQuantity: parseInt(newQuantity) || 0
            });
        }

    } catch (error) {
        console.error('❌ Error updating quantity:', error);
        res.status(500).json({
            error: 'Failed to update quantity',
            details: error.message
        });
    }
});

// Replace sauce endpoint
app.patch('/api/orders/:token/replace-sauce', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, newSauceId, oldSauceId } = req.body;

        console.log('🍶 Replacing sauce:', oldSauceId, '->', newSauceId);

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // // Remove all current sauce ingredients
        // const updatedIngredientIds = [];
        // for (const ingredientId of currentIngredientIds) {
        //     try {
        //         const ingredient = await base('Ingredients').find(ingredientId);
        //         if (ingredient.fields['Component'] !== 'Sauce') {
        //             updatedIngredientIds.push(ingredientId); // Keep non-sauce ingredients
        //         }
        //     } catch (err) {
        //         updatedIngredientIds.push(ingredientId); // Keep if can't check component
        //     }
        // }

        // Cache components for all ingredients first
        await cacheIngredientComponents(currentIngredientIds);

        // Now filter without API calls
        const updatedIngredientIds = currentIngredientIds.filter(id =>
            CACHED_INGREDIENT_COMPONENTS[id] !== 'Sauce'
        );


        // Add new sauce if not "No Sauce"
        if (newSauceId) {
            updatedIngredientIds.push(newSauceId);
        }

        console.log('🍶 Updated ingredients:', updatedIngredientIds);

        const customerEdits = orderRecord.fields['Customer Edits'] || '';

        // Get ingredient names for logging
        const oldSauceName = await getIngredientName(oldSauceId);
        const newSauceName = await getIngredientName(newSauceId);

        // Update Final Ingredients After User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + oldSauceName + ' replaced with ' + newSauceName + ';\n'
            }
        }]);

        res.json({
            success: true,
            message: 'Sauce updated successfully',
            updatedIngredientIds: updatedIngredientIds
        });

    } catch (error) {
        console.error('❌ Error replacing sauce:', error);
        res.status(500).json({
            error: 'Failed to replace sauce',
            details: error.message
        });
    }
});

// Toggle garnish endpoint (same as ingredient toggle but filtered)
app.patch('/api/orders/:token/toggle-garnish', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, garnishId, shouldActivate } = req.body;

        console.log('🌿 Toggling garnish:', garnishId, shouldActivate ? 'ON' : 'OFF');

        // Get current order record
        const orderRecord = await base('Open Orders').find(recordId);
        if (!orderRecord) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients After User Edits'] || [];

        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // Toggle the garnish
        let updatedIngredientIds;
        if (shouldActivate) {
            // Add garnish if not already active
            updatedIngredientIds = currentIngredientIds.includes(garnishId)
                ? currentIngredientIds
                : [...currentIngredientIds, garnishId];
        } else {
            // Remove garnish
            updatedIngredientIds = currentIngredientIds.filter(id => id !== garnishId);
        }

        const customerEdits = orderRecord.fields['Customer Edits'] || '';

        // Get ingredient name for logging
        const ingredientName = await getIngredientName(garnishId);

        // Update Final Ingredients after User Edits
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients After User Edits': updatedIngredientIds,
                'Customer Edits': customerEdits + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' - ' + ingredientName + ' ' + (shouldActivate ? 'added' : 'removed') + ';\n'
            }
        }]);

        res.json({
            success: true,
            message: `Garnish ${shouldActivate ? 'added' : 'removed'}`,
            updatedIngredientIds: updatedIngredientIds
        });

    } catch (error) {
        console.error('❌ Error toggling garnish:', error);
        res.status(500).json({
            error: 'Failed to toggle garnish',
            details: error.message
        });
    }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Nutrition-aware server running on port ${PORT}`));

// Add this to your existing server.js - UPDATED GET endpoint with ingredients


// NEW ENDPOINT - Delete ingredients from an order