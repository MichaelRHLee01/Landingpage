const express = require('express');
const { base } = require('./airtable');
const { sendWeeklyEmails } = require('./emailer');

const app = express();
app.use(express.json());

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

        console.log('PATCH request received for token:', token);

        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ error: 'Invalid updates format' });
        }

        // Verify customer exists
        const customerRecords = await base('Meal URL').select({
            filterByFormula: `{Unique ID} = '${token}'`,
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
        console.log('Successfully updated', updatedRecords.length, 'records');

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
    req.setTimeout(8000, () => {
        res.status(408).json({ error: 'Request timeout - try refreshing' });
    });

    try {
        const token = req.params.token;
        console.log('Fetching orders for token:', token);

        // Step 1: Find the customer record first (with filtering to reduce data)
        const customerRecords = await base('Meal URL').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            console.log('Customer not found for token:', token);
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customerRecord = customerRecords[0];
        console.log('Found customer:', customerRecord.fields.Name);

        // Step 2: Get client nutrition profile using the identifier
        const clientIdentifier = customerRecord.fields['Client_Nutrition_Identifier'];
        console.log('Looking for client with identifier:', clientIdentifier);

        // Extract email from the identifier format: "Name | Meal | email@domain.com"
        const customerName = customerRecord.fields['Name'];
        let customerEmail = null;

        if (clientIdentifier && clientIdentifier.includes('|')) {
            const parts = clientIdentifier.split('|').map(part => part.trim());
            if (parts.length >= 3) {
                customerEmail = parts[2]; // Email is the third part
            }
        }

        console.log('Customer details:', {
            name: customerName,
            email: customerEmail,
            identifier: clientIdentifier
        });

        if (!customerEmail) {
            console.log('Could not extract email from identifier');
            return res.status(400).json({ error: 'Customer email not found in identifier' });
        }

        console.log('🔍 Searching for ALL client records for email:', customerEmail);

        const allClientRecords = await base('Client').select({
            filterByFormula: `{TypyForm_Email} = '${customerEmail}'`
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
        const allOrderRecordIds = [];
        const orderToMealTypeMap = {}; // Track which meal type each order belongs to

        allClientRecords.forEach(clientRecord => {
            const orderIds = clientRecord.fields['Open Orders'] || [];
            const mealType = clientRecord.fields['Meal']; // Breakfast, Lunch, Dinner, Snack

            orderIds.forEach(orderId => {
                allOrderRecordIds.push(orderId);
                orderToMealTypeMap[orderId] = mealType; // Map order ID to meal type
            });
        });

        // Remove duplicates but keep the meal type mapping
        const uniqueOrderIds = [...new Set(allOrderRecordIds)];
        console.log('Total unique orders across all meal types:', uniqueOrderIds.length);

        if (!uniqueOrderIds.length) {
            return res.json({
                customer: {
                    name: customerRecord.fields.Name,
                    email: customerRecord.fields.Email
                },
                nutritionGoals: {
                    calories: clientProfile.fields['goal_calories'] || 0,
                    carbs: clientProfile.fields['goal_carbs(g)'] || 0,
                    protein: clientProfile.fields['goal_protein(g)'] || 0,
                    fat: clientProfile.fields['goal_fat(g)'] || 0,
                    fiber: clientProfile.fields['goal_fiber(g)'] || 0,
                    allergies: clientProfile.fields['Allergies_Diet'] || [],
                    notes: clientProfile.fields['Notes'] || '',
                    snacksPerDay: clientProfile.fields['# of snacks per day'] || 0
                },
                currentTotals: { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 },
                orders: [],
                summary: { totalMeals: 0, calorieProgress: 0 }
            });
        }

        // Step 4: Fetch only the specific order records we need
        const orderPromises = uniqueOrderIds.map(recordId =>
            base('Open Orders').find(recordId).catch(err => {
                console.warn('Could not find order:', recordId, err.message);
                return null;
            })
        );

        const orderRecords = (await Promise.all(orderPromises)).filter(Boolean);
        console.log('Successfully loaded', orderRecords.length, 'order records');

        // Step 5: Get unique allergy/diet record IDs to resolve names
        const allergyRecordIds = new Set();
        orderRecords.forEach(r => {
            if (r.fields['Allergies_Diet']) {
                r.fields['Allergies_Diet'].forEach(id => allergyRecordIds.add(id));
            }
        });

        // Also get from client profile
        if (clientProfile.fields['Allergies_Diet']) {
            clientProfile.fields['Allergies_Diet'].forEach(id => allergyRecordIds.add(id));
        }

        // Fetch allergy/diet names
        const allergyNames = {};
        if (allergyRecordIds.size > 0) {
            try {
                // Try different possible table names for allergies/diet restrictions
                const possibleTableNames = ['Allergies Diet', 'Allergies_Diet', 'Diet Restrictions', 'Allergies', 'Diet'];
                let allergyRecords = [];

                for (const tableName of possibleTableNames) {
                    try {
                        console.log(`Trying allergy table: "${tableName}"`);
                        const allergyPromises = Array.from(allergyRecordIds).slice(0, 3).map(id =>
                            base(tableName).find(id).catch(err => null)
                        );
                        const testRecords = (await Promise.all(allergyPromises)).filter(Boolean);
                        if (testRecords.length > 0) {
                            console.log(`Found allergy table: "${tableName}"`);
                            const allAllergyPromises = Array.from(allergyRecordIds).map(id =>
                                base(tableName).find(id).catch(err => {
                                    console.warn('Could not find allergy record:', id);
                                    return null;
                                })
                            );
                            allergyRecords = (await Promise.all(allAllergyPromises)).filter(Boolean);
                            break;
                        }
                    } catch (err) {
                        console.log(`Table "${tableName}" not found`);
                        continue;
                    }
                }

                allergyRecords.forEach(record => {
                    // The field name is 'Allergy to/ (As) Diet Type' based on the logs
                    const allergyName = record.fields['Allergy to/ (As) Diet Type'] || 'Unknown';
                    allergyNames[record.id] = allergyName;
                    console.log(`Mapped allergy ${record.id} -> ${allergyName}`);
                });
                console.log('Resolved allergy names:', allergyNames);
            } catch (err) {
                console.warn('Could not fetch allergy names:', err.message);
            }
        }

        // Step 6: Format response with nutrition awareness AND INGREDIENTS
        // Step 5: Get unique ingredient record IDs to resolve names
        const ingredientRecordIds = new Set();
        orderRecords.forEach(r => {
            // Collect ingredient IDs from both Original and Final Ingredients
            if (r.fields['Final Ingredients']) {
                r.fields['Final Ingredients'].forEach(id => ingredientRecordIds.add(id));
            }
            if (r.fields['Original Ingredients']) {
                r.fields['Original Ingredients'].forEach(id => ingredientRecordIds.add(id));
            }
        });

        // Step 6: Fetch ingredient names from Ingredients table
        const ingredientNames = {};
        if (ingredientRecordIds.size > 0) {
            try {
                console.log('Fetching ingredient names for', ingredientRecordIds.size, 'ingredients');

                // SUPER FAST: Use Airtable's bulk select with filtering
                const ingredientRecords = await base('Ingredients').select({
                    filterByFormula: `OR(${Array.from(ingredientRecordIds).map(id => `RECORD_ID() = '${id}'`).join(',')})`,
                    maxRecords: 100
                }).all();

                ingredientRecords.forEach(record => {
                    const ingredientName = record.fields['Ingredient Name'] ||
                        record.fields['Name'] ||
                        record.fields['USDA Name'] ||
                        'Unknown Ingredient';

                    ingredientNames[record.id] = ingredientName;
                });

                console.log('Resolved ingredient names:', Object.keys(ingredientNames).length, 'ingredients');
            } catch (err) {
                console.warn('Could not fetch ingredient names:', err.message);
            }
        }

        // Step 6.5: Get protein substitution options for each order
        const proteinSubstitutionOptions = {};

        for (const orderRecord of orderRecords) {
            const orderId = orderRecord.id;
            const mealType = orderToMealTypeMap[orderId]; // Breakfast, Lunch, Dinner, Snack

            // Get current ingredients
            const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
            const finalIngredientIds = orderRecord.fields['Final Ingredients'] || [];
            const currentIngredientIds = finalIngredientIds.length > 0 ? finalIngredientIds : originalIngredientIds;

            // Find current protein (Component = 'Meat')
            let currentProteinIngredient = null;
            let currentProteinId = null;

            for (const ingredientId of currentIngredientIds) {
                try {
                    const ingredient = await base('Ingredients').find(ingredientId);
                    if (ingredient.fields['Component'] === 'Meat') {
                        currentProteinIngredient = {
                            id: ingredientId,
                            name: ingredient.fields['Ingredient Name'] || ingredient.fields['USDA Name'] || 'Unknown',
                            component: ingredient.fields['Component']
                        };
                        currentProteinId = ingredientId;
                        break;
                    }
                } catch (err) {
                    continue;
                }
            }

            let proteinOptions = [];

            if (currentProteinIngredient && currentProteinId) {
                try {
                    // REVERSE LOOKUP: Find what variant type this protein belongs to
                    const allVariants = await base('Variants').select({
                        filterByFormula: `{Availability} = TRUE()`
                    }).all();

                    let relevantVariantType = null;

                    // Find variant type by looking for current protein in Ingredient column
                    for (const variant of allVariants) {
                        const variantIngredients = variant.fields['Ingredient'] || [];
                        if (variantIngredients.includes(currentProteinId)) {
                            relevantVariantType = variant.fields['Variant Type'];
                            console.log(`🥩 Found variant type for ${currentProteinIngredient.name}: ${relevantVariantType}`);
                            break;
                        }
                    }

                    if (relevantVariantType) {
                        // Get all substitutions of this variant type for this meal
                        const proteinSubstitutions = allVariants.filter(variant => {
                            const variantType = variant.fields['Variant Type'];
                            const applicableTo = variant.fields['Applicable to'] || '';
                            const availability = variant.fields['Availability'];

                            return variantType === relevantVariantType &&
                                applicableTo.includes(mealType) &&
                                availability === true;
                        });

                        console.log(`🥩 Found ${proteinSubstitutions.length} protein options for ${mealType} ${relevantVariantType}`);

                        // Convert to ingredient details
                        for (const variant of proteinSubstitutions) {
                            const variantIngredientIds = variant.fields['Ingredient'] || [];
                            for (const ingredientId of variantIngredientIds) {
                                try {
                                    const ingredient = await base('Ingredients').find(ingredientId);
                                    proteinOptions.push({
                                        id: ingredientId,
                                        name: ingredient.fields['Ingredient Name'] || ingredient.fields['USDA Name'] || 'Unknown',
                                        variantName: variant.fields['Variant Name'],
                                        isActive: ingredientId === currentProteinId
                                    });
                                } catch (err) {
                                    console.warn('Could not fetch protein ingredient:', ingredientId);
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Error fetching protein options for order:', orderId, err.message);
                }
            }

            proteinSubstitutionOptions[orderId] = {
                currentProtein: currentProteinIngredient,
                options: proteinOptions
            };
        }



        // Step 7: Format response with RESOLVED INGREDIENTS
        const orders = await Promise.all(orderRecords.map(async (r) => {
            const originalIngredientIds = r.fields['Original Ingredients'] || [];
            const finalIngredientIds = r.fields['Final Ingredients'] || [];
            const currentIngredientIds = finalIngredientIds.length > 0 ? finalIngredientIds : originalIngredientIds;
            const ingredientsList = currentIngredientIds.map(id => ingredientNames[id] || id).filter(Boolean);


            const allIngredientIds = [...new Set([...originalIngredientIds, ...currentIngredientIds])];
            const allIngredients = allIngredientIds.map(id => ({
                id,
                name: ingredientNames[id] || id
            }));


            // NEW: Fetch image from Products/Weekly Menu
            let imageUrl = null;
            try {
                console.log(`🖼️ Fetching image for: ${r.fields['Airtable ItemName']}`);

                const productRecords = await base('Products/Weekly Menu').select({
                    filterByFormula: `{Product Title} = '${r.fields['Airtable ItemName']}'`,
                    maxRecords: 1
                }).all();

                console.log(`🖼️ Found ${productRecords.length} product records`);

                if (productRecords.length > 0) {
                    const product = productRecords[0];
                    console.log(`🖼️ Product fields:`, Object.keys(product.fields));

                    // Try different field names
                    const imageField = product.fields['Images (view only)'] ||
                        product.fields['Images'] ||
                        product.fields['Image'];

                    console.log(`🖼️ Image field:`, imageField);

                    if (Array.isArray(imageField) && imageField.length > 0) {
                        console.log(`🖼️ First image object:`, imageField[0]);
                        imageUrl = imageField[0].thumbnails?.large?.url ||
                            imageField[0].thumbnails?.small?.url ||
                            imageField[0].url;
                        console.log(`🖼️ Final image URL:`, imageUrl);
                    }
                }
            } catch (err) {
                console.error(`❌ Image fetch error for ${r.fields['Airtable ItemName']}:`, err);
            }


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


                // Nutrition
                calories: r.fields['Calories'] || 150,
                carbs: r.fields['Carbs'] || 15,
                protein: r.fields['Protein'] || 5,
                fat: r.fields['Fat'] || 8,
                fiber: r.fields['Fiber'] || 3,

                allergies: (r.fields['Allergies_Diet'] || []).map(id => allergyNames[id] || id).filter(Boolean),

                // ✅ Add image
                imageUrl
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
            allergies: (clientProfile.fields['Allergies_Diet'] || []).map(id => allergyNames[id] || id).filter(Boolean),
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
                name: customerRecord.fields.Name,
                email: customerEmail
            },
            nutritionGoals: clientGoals,
            currentTotals: currentTotals,
            orders: orders,
            proteinSubstitutionOptions: proteinSubstitutionOptions,
            summary: {
                totalMeals: orders.length,
                calorieProgress: clientGoals.calories > 0 ? (currentTotals.calories / clientGoals.calories * 100).toFixed(1) : 0
            }
        };

        console.log('Returning optimized response with', orders.length, 'orders and ingredients');
        res.json(response);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});


// ============ NEW ENDPOINT: Replace Protein ============

app.patch('/api/orders/:token/replace-protein', async (req, res) => {
    try {
        const token = req.params.token;
        const { recordId, newProteinId, oldProteinId } = req.body;

        console.log('🥩 Replacing protein:', oldProteinId, '->', newProteinId);

        // Verify customer exists
        const customerRecords = await base('Meal URL').select({
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
        const finalIngredientIds = orderRecord.fields['Final Ingredients'] || [];

        // Use Final Ingredients if exists, otherwise copy from Original
        let currentIngredientIds = finalIngredientIds.length > 0
            ? [...finalIngredientIds]
            : [...originalIngredientIds];

        // Replace old protein with new protein
        const updatedIngredientIds = currentIngredientIds.map(id =>
            id === oldProteinId ? newProteinId : id
        );

        console.log('🥩 Updated ingredients:', updatedIngredientIds);

        // Update Final Ingredients
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients': updatedIngredientIds
            }
        }]);

        // Get new protein name for response
        let newProteinName = 'Unknown';
        try {
            const newProteinRecord = await base('Ingredients').find(newProteinId);
            newProteinName = newProteinRecord.fields['Ingredient Name'] || newProteinRecord.fields['USDA Name'] || 'Unknown';
        } catch (err) {
            console.warn('Could not fetch new protein name');
        }

        res.json({
            success: true,
            message: `Protein updated to ${newProteinName}`,
            updatedIngredientIds: updatedIngredientIds
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
        const customerRecords = await base('Meal URL').select({
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
        const finalIngredientIds = orderRecord.fields['Final Ingredients'] || [];

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

        // Update Final Ingredients
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients': updatedIngredientIds
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
        const customerRecords = await base('Meal URL').select({
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

        // Get current ingredient IDs (linked records) - PRIORITIZE Final Ingredients
        const originalIngredientIds = orderRecord.fields['Original Ingredients'] || [];
        const finalIngredientIds = orderRecord.fields['Final Ingredients'] || [];

        // Use Final Ingredients if exists, otherwise copy from Original to start customization
        let currentIngredientIds;
        if (finalIngredientIds.length > 0) {
            currentIngredientIds = finalIngredientIds;
            console.log('Using existing Final Ingredients:', currentIngredientIds);
        } else {
            currentIngredientIds = [...originalIngredientIds]; // Copy original to start customizing
            console.log('Copying Original to Final Ingredients:', currentIngredientIds);
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

        // Update the Final Ingredients field with the modified list of IDs
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Final Ingredients': updatedIngredientIds
            }
        }]);

        console.log('Successfully updated Final Ingredients in Airtable');

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

        console.log('🔄 Updating quantity for:', itemName, 'to', newQuantity);

        // Verify customer exists
        const customerRecords = await base('Meal URL').select({
            filterByFormula: `{Unique ID} = '${token}'`,
            maxRecords: 1
        }).all();

        if (!customerRecords.length) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Simple single record update
        await base('Open Orders').update([{
            id: recordId,
            fields: {
                'Quantity': parseInt(newQuantity) || 0
            }
        }]);

        console.log('✅ Successfully updated quantity');

        res.json({
            success: true,
            message: `Updated ${itemName} quantity to ${newQuantity}`,
            recordId: recordId,
            newQuantity: parseInt(newQuantity) || 0
        });

    } catch (error) {
        console.error('❌ Error updating quantity:', error);
        res.status(500).json({
            error: 'Failed to update quantity',
            details: error.message
        });
    }
});




const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Nutrition-aware server running on port ${PORT}`));

// Add this to your existing server.js - UPDATED GET endpoint with ingredients


// NEW ENDPOINT - Delete ingredients from an order
