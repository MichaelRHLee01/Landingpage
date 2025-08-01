import { useSearchParams } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import axios from './api';
import './MealPlanViewer.css';


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

    const modalRef = useRef(null);

    // State for price confirmation
    const [showPriceConfirm, setShowPriceConfirm] = useState(null);




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

        // Save scroll position
        const scrollTop = modalRef.current?.scrollTop || 0;

        console.log('Scroll position:', scrollTop);

        if (oldQuantity === 0 && finalQuantity === 1) {
            console.log('🍽️ Adding new dish:', order.itemName, 'Dish ID:', order.dishId);

            try {
                setSaving(true);
                setError(null);

                // Call new add-dish endpoint
                const response = await axios.post(`/orders/${token}/add-dish`, {
                    dishId: order.dishId,
                    mealType: order.meal
                });

                console.log('✅ Successfully added dish:', response.data);

                // Update the order in local state with new record ID
                const updatedOrders = [...orders];
                updatedOrders[index] = {
                    ...updatedOrders[index],
                    quantity: 1,
                    recordId: response.data.recordId,
                    isOrdered: true,
                    hasCustomIngredients: false // New dish starts without customizations
                };

                flushSync(() => {
                    // setOrders(updatedOrders);
                    const sorted = [
                        ...updatedOrders.filter(order => order.quantity > 0),
                        ...updatedOrders.filter(order => order.quantity === 0)
                    ];
                    setOrders(sorted);
                });

                // Update original orders to reflect saved state
                const updatedOriginalOrders = [...originalOrders];
                updatedOriginalOrders[index] = {
                    ...updatedOriginalOrders[index],
                    quantity: 1,
                    recordId: response.data.recordId
                };
                setOriginalOrders(updatedOriginalOrders);

                setSuccessMessage(`Added ${order.itemName} to your ${order.meal.toLowerCase()} meals!`);
                setTimeout(() => setSuccessMessage(''), 3000);

                if (modalRef.current) {
                    modalRef.current.scrollTop = scrollTop;
                }

                return; // Exit early - don't proceed to regular quantity update logic

            } catch (err) {
                console.error('❌ Error adding new dish:', err);
                setError(err.response?.data?.error || 'Failed to add dish');

                // Don't update UI on error - quantity stays at 0
                return;
            } finally {
                setSaving(false);
            }
        }



        // Handle quantity changes
        if (finalQuantity !== oldQuantity) {
            try {
                setSaving(true);
                setError(null);

                if (finalQuantity === 0) {
                    // Remove the card entirely
                    // const updatedOrders = orders.filter((_, i) => i !== index);
                    // flushSync(() => {
                    //     setOrders(updatedOrders);
                    // });

                    const updatedOrders = [...orders];
                    updatedOrders[index] = {
                        ...updatedOrders[index],
                        quantity: 0,
                        recordId: null,
                        isOrdered: false,
                        hasCustomIngredients: false
                    };

                    flushSync(() => {
                        const sorted = [
                            ...updatedOrders.filter(order => order.quantity > 0),
                            ...updatedOrders.filter(order => order.quantity === 0)
                        ];
                        setOrders(sorted);
                    });

                    await axios.patch(`/orders/${token}/quantity`, {
                        recordId: order.recordId,
                        newQuantity: 0,
                        itemName: order.itemName
                    });

                } else if (finalQuantity > oldQuantity) {
                    // INCREASE: Add duplicate cards immediately
                    const updatedOrders = [...orders];
                    const duplicatesToAdd = finalQuantity - oldQuantity;

                    // Add placeholder cards immediately
                    for (let i = 0; i < duplicatesToAdd; i++) {
                        updatedOrders.push({
                            ...order,
                            recordId: null, // Temporary - will be updated after backend call
                            quantity: 1,
                            isTemporary: true // Mark as temporary
                        });
                    }

                    flushSync(() => {
                        // setOrders(updatedOrders);
                        const sorted = [
                            ...updatedOrders.filter(order => order.quantity > 0),
                            ...updatedOrders.filter(order => order.quantity === 0)
                        ];
                        setOrders(sorted);
                    });

                    // Make backend call
                    const response = await axios.patch(`/orders/${token}/quantity`, {
                        recordId: order.recordId,
                        newQuantity: finalQuantity,
                        itemName: order.itemName
                    });

                    // Update the temporary cards with real record IDs
                    const finalOrders = [...updatedOrders];
                    const newRecordIds = response.data.newRecordIds || [];

                    let tempCardIndex = 0;
                    for (let i = 0; i < finalOrders.length; i++) {
                        if (finalOrders[i].isTemporary) {
                            finalOrders[i] = {
                                ...finalOrders[i],
                                recordId: newRecordIds[tempCardIndex],
                                isTemporary: false
                            };
                            tempCardIndex++;
                        }
                    }

                    flushSync(() => {
                        // setOrders(finalOrders);
                        const sorted = [
                            ...finalOrders.filter(order => order.quantity > 0),
                            ...finalOrders.filter(order => order.quantity === 0)
                        ];
                        setOrders(sorted);

                    });

                } else {
                    // DECREASE: Remove cards
                    const cardsToRemove = oldQuantity - finalQuantity;
                    const updatedOrders = [...orders];

                    // Remove cards with same dishId/meal, starting from the end
                    for (let i = updatedOrders.length - 1; i >= 0 && cardsToRemove > 0; i--) {
                        if (updatedOrders[i].dishId === order.dishId &&
                            updatedOrders[i].meal === order.meal &&
                            i !== index) {
                            updatedOrders.splice(i, 1);
                            cardsToRemove--;
                        }
                    }

                    flushSync(() => {
                        // setOrders(updatedOrders);
                        const sorted = [
                            ...updatedOrders.filter(order => order.quantity > 0),
                            ...updatedOrders.filter(order => order.quantity === 0)
                        ];
                        setOrders(sorted);
                    });

                    await axios.patch(`/orders/${token}/quantity`, {
                        recordId: order.recordId,
                        newQuantity: finalQuantity,
                        itemName: order.itemName
                    });
                }

                setSuccessMessage(`Updated ${order.itemName} servings`);
                setTimeout(() => setSuccessMessage(''), 2000);

                if (modalRef.current) {
                    modalRef.current.scrollTop = scrollTop;
                }

            } catch (err) {
                // Revert UI on error
                fetchMealPlan(); // Just refresh everything on error to be safe
                setError(err.response?.data?.error || 'Failed to update quantity');
                console.error('Error updating quantity:', err);
            } finally {
                setSaving(false);
            }
        }
    };

    // END OF HANDLEQUANTITYCHANGE

    const useScrollArrows = () => {
        const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
        const [scrollPositions, setScrollPositions] = useState({});

        useEffect(() => {
            const handleResize = () => setViewportWidth(window.innerWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }, []);

        const shouldShowArrows = (itemCount) => {
            const cardWidth = 280 + 15; // card + gap
            const containerPadding = 40;
            const availableWidth = viewportWidth - containerPadding;
            const maxCards = Math.floor(availableWidth / cardWidth);

            return itemCount > maxCards;
        };

        const updateScrollPosition = (mealType, scrollLeft, scrollWidth, clientWidth) => {
            setScrollPositions(prev => ({
                ...prev,
                [mealType]: {
                    scrollLeft,
                    scrollWidth,
                    clientWidth,
                    canScrollLeft: scrollLeft > 5, // 5px tolerance
                    canScrollRight: scrollLeft < (scrollWidth - clientWidth - 5) // 5px tolerance
                }
            }));
        };

        const getScrollState = (mealType) => {
            return scrollPositions[mealType] || {
                canScrollLeft: false,
                canScrollRight: true
            };
        };

        return {
            shouldShowArrows,
            updateScrollPosition,
            getScrollState,
            viewportWidth
        };
    };

    const { shouldShowArrows, updateScrollPosition, getScrollState } = useScrollArrows();

    const handleScroll = (mealType, event) => {
        const container = event.target;
        updateScrollPosition(
            mealType,
            container.scrollLeft,
            container.scrollWidth,
            container.clientWidth
        );
    };

    const scrollLeft = (mealType) => {
        const container = document.querySelector(`[data-meal-type="${mealType}"]`);
        if (container) {
            container.scrollBy({ left: -300, behavior: 'smooth' });
        }
    };

    const scrollRight = (mealType) => {
        const container = document.querySelector(`[data-meal-type="${mealType}"]`);
        if (container) {
            container.scrollBy({ left: 300, behavior: 'smooth' });
        }
    };

    // Add this useEffect to initialize scroll positions:
    useEffect(() => {
        const initializeScrollPositions = () => {
            ['Breakfast', 'Lunch', 'Dinner', 'Snack'].forEach(mealType => {
                const container = document.querySelector(`[data-meal-type="${mealType}"]`);
                if (container) {
                    updateScrollPosition(
                        mealType,
                        container.scrollLeft,
                        container.scrollWidth,
                        container.clientWidth
                    );
                }
            });
        };

        // Small delay to ensure DOM is ready
        setTimeout(initializeScrollPositions, 100);
    }, [orders]);



    // const handleProteinSubstitution = async (orderIndex, newProteinId, oldProteinId) => {

    //     // Save scroll position
    //     const scrollTop = modalRef.current?.scrollTop || 0;

    //     console.log('Scroll position:', scrollTop);


    //     const order = orders[orderIndex];

    //     try {
    //         setSaving(true);

    //         // Call the protein replacement endpoint
    //         const response = await axios.patch(`/orders/${token}/replace-protein`, {
    //             recordId: order.recordId,
    //             newProteinId: newProteinId,
    //             oldProteinId: oldProteinId
    //         });

    //         // Update local state immediately (no reload needed)
    //         const updatedOrders = [...orders];
    //         updatedOrders[orderIndex] = {
    //             ...updatedOrders[orderIndex],
    //             finalIngredients: response.data.updatedIngredientIds,
    //             hasCustomIngredients: response.data.updatedIngredientIds.length > 0,
    //             proteinOptions: {
    //                 ...updatedOrders[orderIndex].proteinOptions,
    //                 options: updatedOrders[orderIndex].proteinOptions.options.map(option => ({
    //                     ...option,
    //                     isActive: option.id === newProteinId
    //                 }))
    //             }
    //         };
    //         flushSync(() => {
    //             setOrders(updatedOrders);
    //         });


    //         setSuccessMessage(`Protein updated successfully!`);
    //         setTimeout(() => setSuccessMessage(''), 2000);

    //         if (modalRef.current) {
    //             modalRef.current.scrollTop = scrollTop;
    //         }

    //     } catch (err) {
    //         setError(err.response?.data?.error || 'Failed to update protein');
    //         console.error('Error updating protein:', err);
    //     } finally {
    //         setSaving(false);
    //     }
    // };

    const handleProteinSubstitution = async (orderIndex, newProteinId, oldProteinId) => {
        const order = orders[orderIndex];

        // Find the new protein option to check price
        const newProteinOption = order.proteinOptions.options.find(opt => opt.id === newProteinId);
        const upgradePrice = newProteinOption?.price || 0;

        // If there's an upgrade price, show confirmation
        if (upgradePrice > 0) {
            setShowPriceConfirm({
                orderIndex,
                newProteinId,
                oldProteinId,
                proteinName: newProteinOption.displayName || newProteinOption.name,
                price: upgradePrice
            });
            return; // Don't proceed until user confirms
        }

        // No upgrade price, proceed normally
        await executeProteinSubstitution(orderIndex, newProteinId, oldProteinId, 0);
    };

    // Separate function to execute the substitution
    const executeProteinSubstitution = async (orderIndex, newProteinId, oldProteinId, upgradePrice = 0) => {
        const scrollTop = modalRef.current?.scrollTop || 0;
        const order = orders[orderIndex];

        try {
            setSaving(true);

            // Call the protein replacement endpoint with upgrade price
            const response = await axios.patch(`/orders/${token}/replace-protein`, {
                recordId: order.recordId,
                newProteinId: newProteinId,
                oldProteinId: oldProteinId,
                upgradePrice: upgradePrice // Add this field
            });

            // Update local state immediately
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

            flushSync(() => {
                setOrders(updatedOrders);
            });

            const message = upgradePrice > 0
                ? `Protein upgraded! Additional $${upgradePrice} will be added to your invoice.`
                : 'Protein updated successfully!';

            setSuccessMessage(message);
            setTimeout(() => setSuccessMessage(''), 3000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
            }

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update protein');
            console.error('Error updating protein:', err);
        } finally {
            setSaving(false);
            setShowPriceConfirm(null); // Clear confirmation
        }
    };



    // Handle ingredient toggle (add/remove)
    const handleToggleIngredient = async (orderIndex, ingredientName, isCurrentlyActive) => {

        // Save scroll position
        const scrollTop = modalRef.current?.scrollTop || 0;
        console.log('Scroll position:', scrollTop);


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
            flushSync(() => {
                setOrders(updatedOrders);
            });

            setSuccessMessage(
                isCurrentlyActive
                    ? `Removed "${ingredientName}"`
                    : `Added "${ingredientName}"`
            );
            setTimeout(() => setSuccessMessage(''), 2000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
            }
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
                border: meal.quantity === 0 ? '2px dashed #ccc' : '1px solid #ddd', // Dashed border for available dishes
                // border: '1px solid #ddd',
                borderRadius: '8px',
                padding: '10px',
                cursor: 'pointer',
                // backgroundColor: '#fafafa',
                backgroundColor: meal.isTemporary ? '#fff3cd' : (meal.quantity === 0 ? '#f9f9f9' : '#fafafa'), // ADD THIS LINE
                transition: 'all 0.2s ease',
                minHeight: '180px',
                display: 'flex',
                flexDirection: 'column',
                width: '280px',
                flexShrink: 0,
                opacity: meal.quantity === 0 ? 0.8 : 1 // Slightly faded for available dishes

            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#f0f0f0'}
            // onMouseLeave={(e) => e.target.style.backgroundColor = '#fafafa'}
            onMouseLeave={(e) => e.target.style.backgroundColor = meal.quantity === 0 ? '#f9f9f9' : '#fafafa'}

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

            {/* Add temporary indicator */}
            {meal.isTemporary && (
                <div style={{
                    fontSize: '10px',
                    color: '#856404',
                    backgroundColor: '#fff3cd',
                    padding: '2px 4px',
                    borderRadius: '3px',
                    marginBottom: '4px',
                    textAlign: 'center'
                }}>
                    Saving...
                </div>
            )}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {/* Title and quantity controls */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '8px'
                }}>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', flex: 1 }}>
                        {meal.itemName}
                        {meal.quantity === 0 && (
                            <span style={{
                                marginLeft: '6px',
                                fontSize: '10px',
                                backgroundColor: '#e3f2fd',
                                color: '#1976d2',
                                padding: '2px 4px',
                                borderRadius: '3px',
                                fontWeight: 'normal'
                            }}>
                                Available
                            </span>
                        )}
                    </div>

                </div>

                {/* Ingredient list at bottom */}
                <div style={{
                    fontSize: '10px',
                    color: '#666',
                    marginTop: 'auto',
                    lineHeight: '1.2'
                }}>
                    {meal.ingredients && meal.ingredients.length > 0
                        ? meal.ingredients.join(', ')
                        : 'No ingredients listed'
                    }
                </div>


                {/* Quantity controls at bottom */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '5px' }}>
                    <span style={{ fontSize: '10px', color: '#666' }}>
                        Qty: {meal.quantity}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleQuantityChange(actualIndex, Math.max(0, meal.quantity - 1));
                            }}
                            disabled={saving || meal.quantity <= 0}
                            style={{
                                padding: '2px 6px',
                                border: '1px solid #dc3545',
                                borderRadius: '3px',
                                backgroundColor: '#f8f9fa',
                                color: '#dc3545',
                                cursor: (saving || meal.quantity <= 0) ? 'not-allowed' : 'pointer',
                                fontSize: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                        >
                            Delete
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleQuantityChange(actualIndex, meal.quantity + 1);
                            }}
                            disabled={saving}
                            style={{
                                padding: '2px 6px',
                                border: '1px solid #28a745',
                                borderRadius: '3px',
                                backgroundColor: '#f8f9fa',
                                color: '#28a745',
                                cursor: saving ? 'not-allowed' : 'pointer',
                                fontSize: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                        >
                            Add
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    const MealModal = ({ meal, onClose }) => (
        <div
            className="meal-modal-container"
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
                ref={modalRef}
                className='meal-modal'
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
                    <div
                        className="meal-modal-content"
                        style={{
                            display: 'flex',
                            gap: '20px',
                            alignItems: 'flex-start'
                        }}>
                        {/* Image section */}
                        <div
                            className="meal-modal-image"
                            style={{
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
                        <div
                            className="meal-modal-details"
                            style={{
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
                                        {meal.quantity === 0 && (
                                            <span style={{
                                                marginLeft: '8px',
                                                fontSize: '12px',
                                                backgroundColor: '#e3f2fd',
                                                color: '#1976d2',
                                                padding: '2px 6px',
                                                borderRadius: '3px'
                                            }}>
                                                Available to Add
                                            </span>
                                        )}
                                        {/* {meal.hasCustomIngredients && meal.quantity > 0 && (
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
                                        )} */}
                                        {/* {meal.hasCustomIngredients && (
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
                                        )} */}
                                    </h4>
                                    {/* <div style={{ fontSize: '12px', color: '#666' }}>
                                        Per serving: {meal.calories}cal • {meal.protein}g protein • {meal.carbs}g carbs
                                    </div> */}
                                </div>
                            </div>

                            {/* ✅ NEW: Show note for available dishes */}
                            {meal.quantity === 0 && (
                                <div style={{
                                    backgroundColor: '#e3f2fd',
                                    border: '1px solid #bbdefb',
                                    borderRadius: '6px',
                                    padding: '12px',
                                    fontSize: '14px',
                                    color: '#1565c0'
                                }}>
                                    <strong>Available Dish:</strong> This dish is available for this week but not currently in your meal plan. Click + to add it to your orders!
                                </div>
                            )}


                            {/* ✅ CONDITIONAL: Only show substitution options for ordered dishes (quantity > 0) */}
                            {meal.quantity > 0 && (
                                <>
                                    <ProteinSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                                    <VeggieSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                                    <StarchSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                                    {meal.meal !== 'Snack' && (
                                        <SauceSubstitutionSection order={meal} orderIndex={meal.actualIndex} />
                                    )}
                                    <GarnishSubstitutionSection order={meal} orderIndex={meal.actualIndex} />

                                    {/* Ingredients section for snacks */}
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
                                            <div
                                                className="ingredient-buttons"
                                                style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    gap: '8px'
                                                }}>
                                                {meal.allIngredients.map((ingredient, ingredientIndex) => {
                                                    const isActive = meal.ingredients.includes(ingredient.name);
                                                    return (
                                                        <button
                                                            key={ingredientIndex}
                                                            className="ingredient-button"
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
                                </>
                            )}


                            {/* ✅ NEW: Show ingredients preview for available dishes */}
                            {meal.quantity === 0 && (
                                <div>
                                    <label style={{
                                        display: 'block',
                                        marginBottom: '8px',
                                        fontSize: '14px',
                                        fontWeight: 'bold',
                                        color: '#555'
                                    }}>
                                        What's included:
                                    </label>
                                    <div style={{
                                        fontSize: '14px',
                                        color: '#666',
                                        lineHeight: '1.4'
                                    }}>
                                        {meal.ingredients && meal.ingredients.length > 0
                                            ? meal.ingredients.join(', ')
                                            : 'No ingredients listed'
                                        }
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div >
    );


    // Price confirmation modal component
    const PriceConfirmationModal = ({ confirmData, onConfirm, onCancel }) => (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2000 // Higher than meal modal
            }}
            onClick={onCancel}
        >
            <div
                style={{
                    backgroundColor: 'white',
                    borderRadius: '12px',
                    padding: '30px',
                    maxWidth: '400px',
                    margin: '20px',
                    textAlign: 'center',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.3)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <h3 style={{
                    margin: '0 0 15px 0',
                    color: '#333',
                    fontSize: '18px'
                }}>
                    Premium Protein Upgrade
                </h3>

                <p style={{
                    margin: '0 0 20px 0',
                    color: '#666',
                    lineHeight: '1.5'
                }}>
                    Switching to <strong>{confirmData.proteinName}</strong> will cost an additional <strong>${confirmData.price}</strong>. You will be charged through invoice.
                </p>

                <p style={{
                    margin: '0 0 25px 0',
                    fontSize: '14px',
                    color: '#888'
                }}>
                    Is that okay?
                </p>

                <div style={{
                    display: 'flex',
                    gap: '15px',
                    justifyContent: 'center'
                }}>
                    <button
                        onClick={onCancel}
                        style={{
                            padding: '10px 20px',
                            border: '1px solid #ddd',
                            borderRadius: '6px',
                            backgroundColor: '#f8f9fa',
                            color: '#666',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        style={{
                            padding: '10px 20px',
                            border: 'none',
                            borderRadius: '6px',
                            backgroundColor: '#007bff',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: 'bold'
                        }}
                    >
                        Confirm (+${confirmData.price})
                    </button>
                </div>
            </div>
        </div>
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

    const handleSauceSubstitution = async (orderIndex, newSauceId, oldSauceId) => {

        // Save scroll position

        const scrollTop = modalRef.current?.scrollTop || 0;
        console.log('Scroll position:', scrollTop);



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
            flushSync(() => {
                setOrders(updatedOrders);
            });
            setSuccessMessage('Sauce updated successfully!');
            setTimeout(() => setSuccessMessage(''), 2000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
            }

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update sauce');
            console.error('Error updating sauce:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleGarnish = async (orderIndex, garnishId, isCurrentlyActive) => {
        // Save scroll position
        const scrollTop = modalRef.current?.scrollTop || 0;
        console.log('Scroll position:', scrollTop);


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
            flushSync(() => {
                setOrders(updatedOrders);
            });
            setSuccessMessage(
                isCurrentlyActive ? 'Garnish removed' : 'Garnish added'
            );
            setTimeout(() => setSuccessMessage(''), 2000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
            }


        } catch (err) {
            setError(err.response?.data?.error || 'Failed to toggle garnish');
            console.error('Error toggling garnish:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleVeggie = async (orderIndex, veggieId, isCurrentlyActive) => {
        // Save scroll position
        const scrollTop = modalRef.current?.scrollTop || 0;
        console.log('Scroll position:', scrollTop);


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
            flushSync(() => {
                setOrders(updatedOrders);
            });
            setSuccessMessage(
                isCurrentlyActive ? 'Veggie removed' : 'Veggie added'
            );
            setTimeout(() => setSuccessMessage(''), 2000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
                console.log('Tried to restore to:', scrollTop, 'actual scroll now:', modalRef.current.scrollTop);

            }

        } catch (err) {
            setError(err.response?.data?.error || 'Failed to toggle veggie');
            console.error('Error toggling veggie:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleStarchSubstitution = async (orderIndex, newStarchId, oldStarchId) => {
        // Save scroll position
        const scrollTop = modalRef.current?.scrollTop || 0;
        console.log('Scroll position:', scrollTop);

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
            flushSync(() => {
                setOrders(updatedOrders);
            });
            setSuccessMessage('Starch updated successfully!');
            setTimeout(() => setSuccessMessage(''), 2000);

            if (modalRef.current) {
                modalRef.current.scrollTop = scrollTop;
            }

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

    // const currentTotals = calculateCurrentTotals();
    // const goals = mealPlanData.nutritionGoals;
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
                    <h3 style={{ marginBottom: '20px' }}>
                        Your Meals
                    </h3>

                    {/* Group orders by meal type */}
                    {['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(mealType => {
                        const mealOrders = orders.filter(order => order.meal === mealType);
                        const scrollState = getScrollState(mealType);

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
                                        onScroll={(e) => handleScroll(mealType, e)}
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

                                    {/* Left Arrow */}
                                    {shouldShowArrows(mealOrders.length) && scrollState.canScrollLeft && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: '50%',
                                                left: '10px',
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
                                            onClick={() => scrollLeft(mealType)}
                                        >
                                            ←
                                        </div>
                                    )}

                                    {/* Right Arrow */}
                                    {shouldShowArrows(mealOrders.length) && scrollState.canScrollRight && (
                                        <div
                                            style={{
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
                                            onClick={() => scrollRight(mealType)}
                                        >
                                            →
                                        </div>
                                    )}

                                </div>
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

            }
            {showPriceConfirm && (
                <PriceConfirmationModal
                    confirmData={showPriceConfirm}
                    onConfirm={() => {
                        executeProteinSubstitution(
                            showPriceConfirm.orderIndex,
                            showPriceConfirm.newProteinId,
                            showPriceConfirm.oldProteinId,
                            showPriceConfirm.price
                        );
                    }}
                    onCancel={() => setShowPriceConfirm(null)}
                />
            )}
        </div>
    )
}