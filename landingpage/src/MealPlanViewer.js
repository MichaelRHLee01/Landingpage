import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import axios from './api';

export default function MealPlanViewer() {
    const [params] = useSearchParams();
    const token = params.get('customer');

    const [mealPlanData, setMealPlanData] = useState(null);
    const [orders, setOrders] = useState([]);
    const [originalOrders, setOriginalOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState('');

    // for new UI
    const [selectedMeal, setSelectedMeal] = useState(null);
    const [showModal, setShowModal] = useState(false);



    useEffect(() => {
        if (token) {
            fetchMealPlan();
        } else {
            setError('No customer token provided');
            setLoading(false);
        }
    }, [token]);

    const fetchMealPlan = async () => {

        try {
            setLoading(true);
            setError(null);
            const response = await axios.get(`/orders/${token}`);

            setMealPlanData(response.data);
            setOrders(response.data.orders || []);
            setOriginalOrders(JSON.parse(JSON.stringify(response.data.orders || []))); // Deep copy


        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load meal plan');
            console.error('Error fetching meal plan:', err);
        } finally {
            setLoading(false);
        }
    };

    const getIngredientButtonStyle = (isActive, saving) => ({
        display: 'flex',
        alignItems: 'center',
        backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
        border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
        borderRadius: '20px',
        padding: '6px 12px',
        fontSize: '13px',
        color: isActive ? '#155724' : '#6c757d',
        cursor: saving ? 'not-allowed' : 'pointer',
        opacity: saving ? 0.6 : 1,
        transition: 'all 0.2s ease'
    });


    const calculateCurrentTotals = () => {
        return orders.reduce((totals, order) => ({
            calories: totals.calories + (order.calories * order.quantity),
            carbs: totals.carbs + (order.carbs * order.quantity),
            protein: totals.protein + (order.protein * order.quantity),
            fat: totals.fat + (order.fat * order.quantity),
            fiber: totals.fiber + (order.fiber * order.quantity)
        }), { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 });
    };

    const openModal = (meal, actualIndex) => {
        setSelectedMeal({ ...meal, actualIndex });
        setShowModal(true);
    };

    const closeModal = () => {
        setShowModal(false);
        setSelectedMeal(null);
    };


    const handleQuantityChange = async (index, newQuantity) => {
        const order = orders[index];
        const oldQuantity = order.quantity;
        const finalQuantity = Math.max(0, parseInt(newQuantity) || 0);

        // Update UI immediately for responsiveness
        const updatedOrders = [...orders];
        updatedOrders[index] = {
            ...updatedOrders[index],
            quantity: finalQuantity
        };
        setOrders(updatedOrders);

        // If quantity actually changed, save to Airtable
        if (finalQuantity !== oldQuantity) {
            try {
                setSaving(true);
                setError(null);

                // Use the new simpler endpoint
                await axios.patch(`/orders/${token}/quantity`, {
                    recordId: order.recordId,
                    newQuantity: finalQuantity,
                    itemName: order.itemName
                });

                // Update original orders to reflect saved state
                const updatedOriginalOrders = [...originalOrders];
                updatedOriginalOrders[index] = {
                    ...updatedOriginalOrders[index],
                    quantity: finalQuantity
                };
                setOriginalOrders(updatedOriginalOrders);

                setSuccessMessage(`Updated ${order.itemName} to ${finalQuantity} serving${finalQuantity !== 1 ? 's' : ''}`);
                setTimeout(() => setSuccessMessage(''), 2000);

            } catch (err) {
                // Revert UI on error
                const revertedOrders = [...orders];
                revertedOrders[index] = {
                    ...revertedOrders[index],
                    quantity: oldQuantity
                };
                setOrders(revertedOrders);

                setError(err.response?.data?.error || 'Failed to update quantity');
                console.error('Error updating quantity:', err);
            } finally {
                setSaving(false);
            }
        }
    };

    const handleProteinSubstitution = async (orderIndex, newProteinId, oldProteinId) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            // Call the protein replacement endpoint
            const response = await axios.patch(`/orders/${token}/replace-protein`, {
                recordId: order.recordId,
                newProteinId: newProteinId,
                oldProteinId: oldProteinId
            });

            // Update local state immediately (no reload needed)
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                finalIngredients: response.data.updatedIngredientIds,
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
                proteinOptions: {
                    ...updatedOrders[orderIndex].proteinOptions,
                    options: updatedOrders[orderIndex].proteinOptions.options.map(option => ({
                        ...option,
                        isActive: option.id === newProteinId
                    }))
                }
            };
            setOrders(updatedOrders);


            setSuccessMessage(`Protein updated successfully!`);
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update protein');
            console.error('Error updating protein:', err);
        } finally {
            setSaving(false);
        }
    };


    // Handle ingredient toggle (add/remove)
    const handleToggleIngredient = async (orderIndex, ingredientName, isCurrentlyActive) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            // Call the ingredient toggle endpoint
            const response = await axios.patch(`/orders/${token}/ingredients/toggle`, {
                recordId: order.recordId,
                ingredientName: ingredientName,
                shouldActivate: !isCurrentlyActive
            });

            // Update the local state
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                ingredients: response.data.activeIngredients,
                finalIngredients: response.data.finalIngredientIds,
                hasCustomIngredients: response.data.finalIngredientIds.length > 0
            };
            setOrders(updatedOrders);

            setSuccessMessage(
                isCurrentlyActive
                    ? `Removed "${ingredientName}"`
                    : `Added "${ingredientName}"`
            );
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to toggle ingredient');
            console.error('Error toggling ingredient:', err);
        } finally {
            setSaving(false);
        }
    };

    const CompactMealCard = ({ meal, actualIndex }) => (
        <div
            onClick={() => openModal(meal, actualIndex)}
            style={{
                border: '1px solid #ddd',
                borderRadius: '8px',
                padding: '10px',
                cursor: 'pointer',
                backgroundColor: '#fafafa',
                transition: 'all 0.2s ease',
                minHeight: '180px',
                display: 'flex',
                flexDirection: 'column',
                width: '280px',        // ← Fixed width (larger than 200px)
                flexShrink: 0          // ← Prevents shrinking
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#f0f0f0'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#fafafa'}
        >
            {meal.imageUrl && (
                <div style={{
                    width: '100%',
                    height: '150px',
                    backgroundImage: `url(${meal.imageUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    borderRadius: '4px',
                    marginBottom: '8px'
                }} />
            )}

            <div style={{ flex: 1 }}>
                <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '4px' }}>
                    {meal.itemName}
                    {meal.hasCustomIngredients && (
                        <span style={{
                            marginLeft: '4px',
                            fontSize: '10px',
                            backgroundColor: '#f39c12',
                            color: 'white',
                            padding: '1px 4px',
                            borderRadius: '2px'
                        }}>
                            CUSTOMIZED
                        </span>
                    )}
                </div>

                <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>
                    {meal.quantity} serving{meal.quantity !== 1 ? 's' : ''}
                </div>

                <div style={{ fontSize: '10px', color: '#666' }}>
                    {meal.calories}cal • {meal.protein}g protein • {meal.carbs}g carbs
                </div>
            </div>
        </div>
    );

    const MealModal = ({ meal, onClose }) => (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            }}
            onClick={onClose}
        >
            <div
                style={{
                    backgroundColor: 'white',
                    borderRadius: '8px',
                    maxWidth: '800px',
                    maxHeight: '90vh',
                    overflow: 'auto',
                    margin: '20px',
                    position: 'relative'

                }}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute',
                        top: '15px',
                        right: '15px',
                        background: 'none',
                        border: 'none',
                        fontSize: '24px',
                        cursor: 'pointer',
                        zIndex: 1001
                    }}
                >
                    ×
                </button>

                <div style={{ padding: '20px' }}>
                    {/* Put ALL your existing meal detail content here */}
                    {/* This is where your current meal card content goes */}
                    <div style={{
                        display: 'flex',
                        gap: '20px',
                        alignItems: 'flex-start'
                    }}>
                        {/* Image section */}
                        <div style={{
                            flex: '0 0 300px',
                            minHeight: '200px'
                        }}>
                            {meal.imageUrl && (
                                <img
                                    src={meal.imageUrl}
                                    alt={meal.itemName}
                                    style={{
                                        width: '100%',
                                        height: '200px',
                                        objectFit: 'cover',
                                        borderRadius: '8px'
                                    }}
                                />
                            )}
                        </div>

                        {/* Details section - copy your existing content here */}
                        <div style={{
                            flex: '1',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '15px'
                        }}>
                            {/* Title and quantity controls */}
                            <div style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'flex-start'
                            }}>
                                <div>
                                    <h4 style={{ margin: '0 0 5px 0', color: '#333' }}>
                                        {meal.itemName}
                                        {meal.hasCustomIngredients && (
                                            <span style={{
                                                marginLeft: '8px',
                                                fontSize: '12px',
                                                backgroundColor: '#f39c12',
                                                color: 'white',
                                                padding: '2px 6px',
                                                borderRadius: '3px'
                                            }}>
                                                CUSTOMIZED
                                            </span>
                                        )}
                                    </h4>
                                    <div style={{ fontSize: '12px', color: '#666' }}>
                                        Per serving: {meal.calories}cal • {meal.protein}g protein • {meal.carbs}g carbs
                                    </div>
                                </div>

                                {/* Quantity controls */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <label style={{ fontSize: '14px', color: '#666' }}>Servings:</label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                        <button
                                            onClick={() => handleQuantityChange(meal.actualIndex, Math.max(0, meal.quantity - 1))}
                                            disabled={saving || meal.quantity <= 0}
                                            style={{
                                                width: '30px',
                                                height: '30px',
                                                border: '1px solid #ccc',
                                                borderRadius: '4px',
                                                backgroundColor: '#f8f9fa',
                                                cursor: (saving || meal.quantity <= 0) ? 'not-allowed' : 'pointer',
                                                fontSize: '16px'
                                            }}
                                        >
                                            −
                                        </button>
                                        <input
                                            type="number"
                                            value={meal.quantity}
                                            onChange={(e) => handleQuantityChange(meal.actualIndex, parseInt(e.target.value) || 0)}
                                            style={{
                                                width: '60px',
                                                padding: '5px 8px',
                                                border: '1px solid #ccc',
                                                borderRadius: '4px',
                                                fontSize: '14px',
                                                textAlign: 'center'
                                            }}
                                        />
                                        <button
                                            onClick={() => handleQuantityChange(meal.actualIndex, meal.quantity + 1)}
                                            disabled={saving}
                                            style={{
                                                width: '30px',
                                                height: '30px',
                                                border: '1px solid #ccc',
                                                borderRadius: '4px',
                                                backgroundColor: '#f8f9fa',
                                                cursor: saving ? 'not-allowed' : 'pointer',
                                                fontSize: '16px'
                                            }}
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* All your existing substitution sections */}
                            <ProteinSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                            <VeggieSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                            <StarchSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                            <SauceSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                            <GarnishSubstitutionSection order={meal} orderIndex={meal.actualIndex} />

                            {/* Ingredients section */}
                            {meal.meal === 'Snack' && (meal.allIngredients && meal.allIngredients.length > 0) && (
                                <div>
                                    <label style={{
                                        display: 'block',
                                        marginBottom: '8px',
                                        fontSize: '14px',
                                        fontWeight: 'bold',
                                        color: '#555'
                                    }}>
                                        Ingredients (click to add/remove):
                                    </label>
                                    <div style={{
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        gap: '8px'
                                    }}>
                                        {meal.allIngredients.map((ingredient, ingredientIndex) => {
                                            const isActive = meal.ingredients.includes(ingredient.name);
                                            return (
                                                <button
                                                    key={ingredientIndex}
                                                    onClick={() => handleToggleIngredient(meal.actualIndex, ingredient.name, isActive)}
                                                    disabled={saving}
                                                    style={getIngredientButtonStyle(isActive, saving)}
                                                    title={isActive ? `Remove ${ingredient.name}` : `Add ${ingredient.name}`}
                                                >
                                                    <span style={{
                                                        marginRight: '4px',
                                                        fontSize: '12px'
                                                    }}>
                                                        {isActive ? '✓' : '+'}
                                                    </span>
                                                    {ingredient.name}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div >
    );

    const ProteinSubstitutionSection = ({ order, orderIndex }) => {
        // Direct access - no loading state needed!
        const proteinData = order.proteinOptions;

        if (!proteinData || !proteinData.options || proteinData.options.length === 0) {
            return null; // No protein options available
        }

        return (
            <div style={{ marginBottom: '15px' }}>
                <label style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    color: '#555'
                }}>
                    Protein:
                </label>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px'
                }}>
                    {proteinData.options.map((proteinOption, index) => {
                        const isActive = proteinOption.isActive;
                        return (
                            <button
                                key={index}
                                onClick={() => {
                                    if (!isActive) {
                                        const currentActiveOption = proteinData.options.find(opt => opt.isActive);
                                        const oldProteinId = currentActiveOption ? currentActiveOption.id : null;
                                        handleProteinSubstitution(orderIndex, proteinOption.id, oldProteinId);
                                    }
                                }}
                                disabled={saving || isActive}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
                                    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
                                    borderRadius: '20px',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    color: isActive ? '#155724' : '#6c757d',
                                    cursor: (saving || isActive) ? 'not-allowed' : 'pointer',
                                    opacity: (saving || isActive) ? 0.6 : 1,
                                    transition: 'all 0.2s ease'
                                }}
                                title={isActive ? `Current protein: ${proteinOption.displayName || proteinOption.name}` : `Switch to ${proteinOption.displayName || proteinOption.name}`}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {proteinOption.displayName || proteinOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                </div>
            </div>
        );
    };

    const getNutritionProgress = (current, goal) => {
        if (!goal) return 0;
        return Math.min((current / goal) * 100, 100);
    };

    const getProgressColor = (current, goal) => {
        const percentage = (current / goal) * 100;
        if (percentage < 80) return '#f39c12'; // Orange - under target
        if (percentage > 110) return '#e74c3c'; // Red - over target
        return '#27ae60'; // Green - good range
    };

    const handleSauceSubstitution = async (orderIndex, newSauceId, oldSauceId) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            const response = await axios.patch(`/orders/${token}/replace-sauce`, {
                recordId: order.recordId,
                newSauceId: newSauceId,
                oldSauceId: oldSauceId
            });

            // Update local state immediately (no reload needed)
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                finalIngredients: response.data.updatedIngredientIds,
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
                sauceOptions: updatedOrders[orderIndex].sauceOptions.map(sauce => ({
                    ...sauce,
                    isActive: sauce.id === newSauceId
                }))

            };
            setOrders(updatedOrders);

            setSuccessMessage('Sauce updated successfully!');
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update sauce');
            console.error('Error updating sauce:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleGarnish = async (orderIndex, garnishId, isCurrentlyActive) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            const response = await axios.patch(`/orders/${token}/toggle-garnish`, {
                recordId: order.recordId,
                garnishId: garnishId,
                shouldActivate: !isCurrentlyActive
            });

            // Update local state immediately
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                finalIngredients: response.data.updatedIngredientIds,
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
                garnishOptions: updatedOrders[orderIndex].garnishOptions.map(garnish => ({
                    ...garnish,
                    isActive: garnish.id === garnishId ? !isCurrentlyActive : garnish.isActive
                }))

            };
            setOrders(updatedOrders);

            setSuccessMessage(
                isCurrentlyActive ? 'Garnish removed' : 'Garnish added'
            );
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to toggle garnish');
            console.error('Error toggling garnish:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleVeggie = async (orderIndex, veggieId, isCurrentlyActive) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            const response = await axios.patch(`/orders/${token}/toggle-veggie`, {
                recordId: order.recordId,
                veggieId: veggieId,
                shouldActivate: !isCurrentlyActive
            });

            // Update local state immediately
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                finalIngredients: response.data.updatedIngredientIds,
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
                veggieOptions: updatedOrders[orderIndex].veggieOptions.map(veggie => ({
                    ...veggie,
                    isActive: veggie.id === veggieId ? !isCurrentlyActive : veggie.isActive
                }))
            };
            setOrders(updatedOrders);

            setSuccessMessage(
                isCurrentlyActive ? 'Veggie removed' : 'Veggie added'
            );
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to toggle veggie');
            console.error('Error toggling veggie:', err);
        } finally {
            setSaving(false);
        }
    };

    // const handleToggleStarch = async (orderIndex, starchId, isCurrentlyActive) => {
    //     const order = orders[orderIndex];

    //     try {
    //         setSaving(true);

    //         const response = await axios.patch(`/orders/${token}/toggle-starch`, {
    //             recordId: order.recordId,
    //             starchId: starchId,
    //             shouldActivate: !isCurrentlyActive
    //         });

    //         // Update local state immediately
    //         const updatedOrders = [...orders];
    //         updatedOrders[orderIndex] = {
    //             ...updatedOrders[orderIndex],
    //             finalIngredients: response.data.updatedIngredientIds,
    //             hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
    //             starchOptions: updatedOrders[orderIndex].starchOptions.map(starch => ({
    //                 ...starch,
    //                 isActive: starch.id === starchId ? !isCurrentlyActive : starch.isActive
    //             }))
    //         };
    //         setOrders(updatedOrders);

    //         setSuccessMessage(
    //             isCurrentlyActive ? 'Starch removed' : 'Starch added'
    //         );
    //         setTimeout(() => setSuccessMessage(''), 2000);

    //     } catch (err) {
    //         setError(err.response?.data?.error || 'Failed to toggle starch');
    //         console.error('Error toggling starch:', err);
    //     } finally {
    //         setSaving(false);
    //     }
    // };

    const handleStarchSubstitution = async (orderIndex, newStarchId, oldStarchId) => {
        const order = orders[orderIndex];

        try {
            setSaving(true);

            const response = await axios.patch(`/orders/${token}/toggle-starch`, {
                recordId: order.recordId,
                starchId: newStarchId,
                shouldActivate: true  // Always true since we're replacing
            });

            // Update local state immediately (like sauce logic)
            const updatedOrders = [...orders];
            updatedOrders[orderIndex] = {
                ...updatedOrders[orderIndex],
                finalIngredients: response.data.updatedIngredientIds,
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
                starchOptions: updatedOrders[orderIndex].starchOptions.map(starch => ({
                    ...starch,
                    isActive: starch.id === newStarchId  // Only the new one is active
                }))
            };
            setOrders(updatedOrders);

            setSuccessMessage('Starch updated successfully!');
            setTimeout(() => setSuccessMessage(''), 2000);

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update starch');
            console.error('Error updating starch:', err);
        } finally {
            setSaving(false);
        }
    };

    // For the UI:

    const SauceSubstitutionSection = ({ order, orderIndex }) => {
        if (!order.sauceOptions || order.sauceOptions.length === 0) {
            return null;
        }

        return (
            <div style={{ marginBottom: '15px' }}>
                <label style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    color: '#555'
                }}>
                    Sauce:
                </label>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px'
                }}>
                    {order.sauceOptions.map((sauceOption, index) => {
                        const isActive = sauceOption.isActive;
                        return (
                            <button
                                key={index}
                                onClick={() => {
                                    if (!isActive) {
                                        const currentActiveSauce = order.sauceOptions.find(opt => opt.isActive);
                                        const oldSauceId = currentActiveSauce ? currentActiveSauce.id : null;
                                        handleSauceSubstitution(orderIndex, sauceOption.id, oldSauceId);
                                    }
                                }}
                                disabled={saving || isActive}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
                                    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
                                    borderRadius: '20px',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    color: isActive ? '#155724' : '#6c757d',
                                    cursor: (saving || isActive) ? 'not-allowed' : 'pointer',
                                    opacity: (saving || isActive) ? 0.6 : 1,
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {sauceOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                </div>
            </div>
        );
    };

    const GarnishSubstitutionSection = ({ order, orderIndex }) => {
        if (!order.garnishOptions || order.garnishOptions.length === 0) {
            return null;
        }

        return (
            <div style={{ marginBottom: '15px' }}>
                <label style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    color: '#555'
                }}>
                    Garnish:
                </label>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px'
                }}>
                    {order.garnishOptions.map((garnishOption, index) => {
                        const isActive = garnishOption.isActive;
                        return (
                            <button
                                key={index}
                                onClick={() => handleToggleGarnish(orderIndex, garnishOption.id, isActive)}
                                disabled={saving}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
                                    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
                                    borderRadius: '20px',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    color: isActive ? '#155724' : '#6c757d',
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    opacity: saving ? 0.6 : 1,
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {garnishOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                </div>
            </div>
        );
    };

    const VeggieSubstitutionSection = ({ order, orderIndex }) => {
        if (!order.veggieOptions || order.veggieOptions.length === 0) {
            return null;
        }

        return (
            <div style={{ marginBottom: '15px' }}>
                <label style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    color: '#555'
                }}>
                    Veggies:
                </label>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px'
                }}>
                    {order.veggieOptions.map((veggieOption, index) => {
                        const isActive = veggieOption.isActive;
                        return (
                            <button
                                key={index}
                                onClick={() => handleToggleVeggie(orderIndex, veggieOption.id, isActive)}
                                disabled={saving}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
                                    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
                                    borderRadius: '20px',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    color: isActive ? '#155724' : '#6c757d',
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    opacity: saving ? 0.6 : 1,
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {veggieOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                </div>
            </div>
        );
    };

    const StarchSubstitutionSection = ({ order, orderIndex }) => {
        if (!order.starchOptions || order.starchOptions.length === 0) {
            return null;
        }

        return (
            <div style={{ marginBottom: '15px' }}>
                <label style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    color: '#555'
                }}>
                    Starch:
                </label>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px'
                }}>
                    {order.starchOptions.map((starchOption, index) => {
                        const isActive = starchOption.isActive;
                        return (
                            <button
                                key={index}
                                onClick={() => {
                                    // handleToggleStarch(orderIndex, starchOption.id, isActive)
                                    if (!isActive) {
                                        const currentActiveStarch = order.starchOptions.find(opt => opt.isActive);
                                        const oldStarchId = currentActiveStarch ? currentActiveStarch.id : null;
                                        handleStarchSubstitution(orderIndex, starchOption.id, oldStarchId);
                                    }
                                }} // ← Changed to toggle
                                disabled={saving || isActive}
                                style={{
                                    // ... same styling as veggies
                                    display: 'flex',
                                    alignItems: 'center',
                                    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
                                    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
                                    borderRadius: '20px',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    color: isActive ? '#155724' : '#6c757d',
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    opacity: saving ? 0.6 : 1,
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {starchOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                </div>
            </div>
        );
    };

    if (loading) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{
                        border: '4px solid #f3f3f3',
                        borderTop: '4px solid #3498db',
                        borderRadius: '50%',
                        width: '40px',
                        height: '40px',
                        animation: 'spin 2s linear infinite',
                        margin: '0 auto 20px'
                    }}></div>
                    <p>Loading your nutrition-optimized meal plan...</p>
                </div>
                <style jsx>{`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `}</style>
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
                <div style={{
                    backgroundColor: '#fee',
                    border: '1px solid #fcc',
                    borderRadius: '8px',
                    padding: '20px'
                }}>
                    <h2 style={{ color: '#c33', marginBottom: '10px' }}>Error</h2>
                    <p style={{ color: '#c33' }}>{error}</p>
                    <button
                        onClick={fetchMealPlan}
                        style={{
                            marginTop: '15px',
                            padding: '10px 20px',
                            backgroundColor: '#c33',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: 'pointer'
                        }}
                    >
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    if (!mealPlanData || !orders.length) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px', textAlign: 'center' }}>
                <h2>No Meal Plan Found</h2>
                <p>No meal plan data found for this customer.</p>
            </div>
        );
    }

    const currentTotals = calculateCurrentTotals();
    const goals = mealPlanData.nutritionGoals;
    const customer = mealPlanData.customer;

    return (
        <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
            <div style={{
                backgroundColor: 'white',
                borderRadius: '8px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div style={{
                    borderBottom: '1px solid #eee',
                    padding: '20px',
                    backgroundColor: '#f8f9fa'
                }}>
                    <h1 style={{ margin: '0 0 5px 0', color: '#333' }}>
                        Personalized Meal Plan
                    </h1>
                    <p style={{ margin: '0', color: '#666' }}>
                        {customer.name} • {customer.email}
                    </p>
                </div>

                {/* Success Message */}
                {successMessage && (
                    <div style={{
                        margin: '20px',
                        backgroundColor: '#dff0d8',
                        border: '1px solid #d6e9c6',
                        borderRadius: '5px',
                        padding: '15px',
                        color: '#3c763d'
                    }}>
                        {successMessage}
                    </div>
                )}

                {/* Error Message */}
                {error && (
                    <div style={{
                        margin: '20px',
                        backgroundColor: '#f2dede',
                        border: '1px solid #ebccd1',
                        borderRadius: '5px',
                        padding: '15px',
                        color: '#a94442'
                    }}>
                        {error}
                    </div>
                )}

                {/* Meal Orders */}
                <div style={{ padding: '20px' }}>
                    <h3 style={{ marginBottom: '20px' }}>Your Meals</h3>

                    {/* Group orders by meal type */}
                    {['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(mealType => {
                        const mealOrders = orders.filter(order => order.meal === mealType);

                        if (mealOrders.length === 0) return null;

                        return (
                            <div key={mealType} style={{ marginBottom: '30px' }}>
                                <h4 style={{
                                    color: '#333',
                                    marginBottom: '15px',
                                    paddingBottom: '5px',
                                    borderBottom: '2px solid #eee'
                                }}>
                                    {mealType}
                                </h4>
                                <div style={{ position: 'relative' }}>
                                    {/* Scrolling container */}
                                    <div
                                        data-meal-type={mealType}
                                        style={{
                                            display: 'flex',
                                            overflowX: 'auto',
                                            gap: '15px',
                                            paddingBottom: '10px'
                                        }}>
                                        {mealOrders.map((order, index) => {
                                            const actualIndex = orders.indexOf(order);
                                            return (
                                                <CompactMealCard
                                                    key={order.recordId || actualIndex}
                                                    meal={order}
                                                    actualIndex={actualIndex}
                                                />
                                            );
                                        })}
                                    </div>

                                    {/* Fixed arrow button - always visible */}
                                    {mealOrders.length > 3 && (
                                        <div style={{
                                            position: 'absolute',
                                            top: '50%',
                                            right: '10px',
                                            transform: 'translateY(-50%)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            borderRadius: '50%',
                                            width: '40px',
                                            height: '40px',
                                            cursor: 'pointer',
                                            backgroundColor: '#007bff',
                                            color: 'white',
                                            fontSize: '18px',
                                            fontWeight: 'bold',
                                            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                                            zIndex: 10
                                        }}
                                            onClick={() => {
                                                // Scroll to the right when clicked
                                                const container = document.querySelector(`[data-meal-type="${mealType}"]`);
                                                if (container) {
                                                    container.scrollBy({ left: 300, behavior: 'smooth' });
                                                }
                                            }}
                                        >
                                            →
                                        </div>
                                    )}
                                </div>

                                {/* <div style={{
                                    display: 'flex',
                                    overflowX: 'auto',
                                    gap: '15px',
                                    paddingBottom: '10px'
                                }}>
                                    {mealOrders.map((order, index) => {
                                        const actualIndex = orders.indexOf(order);
                                        return (
                                            <CompactMealCard
                                                key={order.recordId || actualIndex}
                                                meal={order}
                                                actualIndex={actualIndex}
                                            />
                                        );
                                    })}
                                    {mealOrders.length > 3 && (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            border: '1px dashed #ccc',
                                            borderRadius: '8px',
                                            minHeight: '180px',
                                            width: '80px',
                                            flexShrink: 0,
                                            cursor: 'pointer',
                                            backgroundColor: '#f9f9f9',
                                            color: '#666',
                                            fontSize: '24px'
                                        }}>
                                            →
                                        </div>
                                    )}
                                </div> */}

                            </div>
                        );
                    })}

                    {/* No more action buttons - changes save automatically */}
                </div>
            </div>
            {showModal && selectedMeal && (
                <MealModal
                    meal={{ ...orders[selectedMeal.actualIndex], actualIndex: selectedMeal.actualIndex }}
                    onClose={closeModal}
                />
            )
                /* {showModal && selectedMeal && (
                    <MealModal meal={selectedMeal} onClose={closeModal} />
                )} */
            }
        </div>
    )
}
