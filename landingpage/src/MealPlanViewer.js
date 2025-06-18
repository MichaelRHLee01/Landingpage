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
    const [proteinSubstitutions, setProteinSubstitutions] = useState({});


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


            setProteinSubstitutions(response.data.proteinSubstitutionOptions || {});


        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load meal plan');
            console.error('Error fetching meal plan:', err);
        } finally {
            setLoading(false);
        }
    };

    const calculateCurrentTotals = () => {
        return orders.reduce((totals, order) => ({
            calories: totals.calories + (order.calories * order.quantity),
            carbs: totals.carbs + (order.carbs * order.quantity),
            protein: totals.protein + (order.protein * order.quantity),
            fat: totals.fat + (order.fat * order.quantity),
            fiber: totals.fiber + (order.fiber * order.quantity)
        }), { calories: 0, carbs: 0, protein: 0, fat: 0, fiber: 0 });
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

    const handleNotesChange = (index, newNotes) => {
        const updatedOrders = [...orders];
        updatedOrders[index] = {
            ...updatedOrders[index],
            nutritionNotes: newNotes
        };
        setOrders(updatedOrders);
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
                hasCustomIngredients: response.data.updatedIngredientIds.length > 0
            };
            setOrders(updatedOrders);

            // Update protein substitutions state
            const updatedProteinSubs = { ...proteinSubstitutions };
            const currentSub = updatedProteinSubs[order.recordId];
            if (currentSub) {
                // Update active status
                currentSub.options = currentSub.options.map(option => ({
                    ...option,
                    isActive: option.id === newProteinId
                }));
                // Update current protein
                const newActiveOption = currentSub.options.find(opt => opt.id === newProteinId);
                if (newActiveOption) {
                    currentSub.currentProtein = {
                        id: newProteinId,
                        name: newActiveOption.name,
                        component: 'Meat'
                    };
                }
            }
            setProteinSubstitutions(updatedProteinSubs);

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

    const ProteinSubstitutionSection = ({ order, orderIndex }) => {
        const proteinData = proteinSubstitutions[order.recordId];

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
                                title={isActive ? `Current protein: ${proteinOption.name}` : `Switch to ${proteinOption.name}`}
                            >
                                <span style={{
                                    marginRight: '4px',
                                    fontSize: '12px'
                                }}>
                                    {isActive ? '✓' : '+'}
                                </span>
                                {proteinOption.name}
                            </button>
                        );
                    })}
                </div>
                <div style={{
                    fontSize: '12px',
                    color: '#6c757d',
                    marginTop: '8px'
                }}>
                    ✓ Current protein • + Available substitutions
                </div>
            </div>
        );
    };


    const hasChanges = () => {
        // No longer needed since we save immediately
        return false;
    };

    const calculateChanges = () => {
        // No longer needed since we save immediately
        return [];
    };

    const handleSubmit = async () => {
        // No longer needed since we save immediately
        return;
    };

    const handleReset = () => {
        // No longer needed since we save immediately
        return;
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

                                {mealOrders.map((order, index) => {
                                    const actualIndex = orders.indexOf(order);
                                    return (
                                        <div key={order.recordId || actualIndex} style={{
                                            border: '1px solid #ddd',
                                            borderRadius: '8px',
                                            padding: '15px',
                                            marginBottom: '15px',
                                            backgroundColor: '#fafafa'
                                        }}>
                                            <div style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'flex-start',
                                                marginBottom: '10px'
                                            }}>
                                                <div style={{ flex: 1 }}>
                                                    {order.imageUrl && (
                                                        <img
                                                            src={order.imageUrl}
                                                            alt={order.itemName}
                                                            style={{
                                                                width: '100%',
                                                                maxHeight: '160px',
                                                                objectFit: 'cover',
                                                                borderRadius: '6px',
                                                                marginBottom: '10px'
                                                            }}
                                                        />
                                                    )}

                                                    <h4 style={{ margin: '0 0 5px 0', color: '#333' }}>
                                                        {order.itemName}
                                                        {order.hasCustomIngredients && (
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
                                                        Per serving: {order.calories}cal • {order.protein}g protein • {order.carbs}g carbs
                                                    </div>
                                                </div>

                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <label style={{ fontSize: '14px', color: '#666' }}>Servings:</label>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                        <button
                                                            onClick={() => handleQuantityChange(actualIndex, Math.max(0, order.quantity - 1))}
                                                            disabled={saving || order.quantity <= 0}
                                                            style={{
                                                                width: '30px',
                                                                height: '30px',
                                                                border: '1px solid #ccc',
                                                                borderRadius: '4px',
                                                                backgroundColor: '#f8f9fa',
                                                                cursor: (saving || order.quantity <= 0) ? 'not-allowed' : 'pointer',
                                                                fontSize: '16px',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                opacity: (saving || order.quantity <= 0) ? 0.5 : 1
                                                            }}
                                                        >
                                                            −
                                                        </button>
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="1"
                                                            value={order.quantity}
                                                            onChange={(e) => handleQuantityChange(actualIndex, parseInt(e.target.value) || 0)}
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
                                                            onClick={() => handleQuantityChange(actualIndex, order.quantity + 1)}
                                                            disabled={saving}
                                                            style={{
                                                                width: '30px',
                                                                height: '30px',
                                                                border: '1px solid #ccc',
                                                                borderRadius: '4px',
                                                                backgroundColor: '#f8f9fa',
                                                                cursor: saving ? 'not-allowed' : 'pointer',
                                                                fontSize: '16px',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                opacity: saving ? 0.5 : 1
                                                            }}
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* PROTEIN SUBSTITUTION SECTION */}
                                            <ProteinSubstitutionSection
                                                order={order}
                                                orderIndex={actualIndex}
                                            />


                                            {/* INGREDIENTS SECTION */}
                                            {(order.allIngredients && order.allIngredients.length > 0) && (
                                                <div style={{ marginBottom: '15px' }}>
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
                                                        {order.allIngredients.map((ingredient, ingredientIndex) => {
                                                            const isActive = order.ingredients.includes(ingredient.name);
                                                            return (
                                                                <button
                                                                    key={ingredientIndex}
                                                                    onClick={() => handleToggleIngredient(actualIndex, ingredient.name, isActive)}
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
                                                    <div style={{
                                                        fontSize: '12px',
                                                        color: '#6c757d',
                                                        marginTop: '8px'
                                                    }}>
                                                        ✓ Active ingredients • + Available to add
                                                    </div>
                                                </div>
                                            )}

                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}

                    {/* No more action buttons - changes save automatically */}
                </div>
            </div>
        </div>
    )
}