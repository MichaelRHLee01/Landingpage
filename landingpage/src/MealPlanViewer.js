import { useSearchParams } from 'react-router-dom';
import { useEffect, useState, useRef, useCallback } from 'react';
import axios from './api';
import './MealPlanViewer.css';

/**
 * MealPlanViewer
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION
 *
 * 1. Sub-components are declared at module scope, not inside the component.
 *    Previously CompactMealCard, MealModal, ProteinSubstitutionSection and the
 *    rest were defined in the render body, so every render produced a NEW
 *    function reference. React compares component types by identity, saw a
 *    different type each time, and unmounted + remounted the whole subtree.
 *    That is what destroyed scroll position and focus, and it is why the old
 *    code needed flushSync and manual modalRef.scrollTop save/restore on every
 *    single handler. With stable identities React reconciles instead, and all
 *    of that compensation code is gone.
 *
 * 2. Server is the single source of truth. Every mutation refetches instead of
 *    hand-patching local state. There were eight separate patch blocks before,
 *    each rebuilding a different slice of `orders` — eight chances to get it
 *    subtly wrong, which is exactly how the protein checkmark drifted out of
 *    sync with the backend. The refetch costs ~3ms against the SQLite backend.
 *    It cost seconds against Airtable, which is why the optimistic machinery
 *    existed in the first place.
 *
 * 3. Cards are identified by recordId, not array index. `actualIndex` was a
 *    position into an array that gets re-sorted on every quantity change, so a
 *    modal held open across a mutation could end up pointing at a different
 *    dish entirely.
 *
 * 4. The five substitution sections were near-identical; they are now one
 *    OptionGroup with a `mode` of 'replace' or 'toggle'.
 */

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const CARD_WIDTH = 295;          // 280px card + 15px gap
const SCROLL_STEP = 300;

// ===========================================================================
// Presentational pieces — module scope, stable identity across renders
// ===========================================================================

const chipStyle = (isActive, disabled) => ({
    display: 'flex',
    alignItems: 'center',
    backgroundColor: isActive ? '#d4edda' : '#f8f9fa',
    border: `1px solid ${isActive ? '#c3e6cb' : '#dee2e6'}`,
    borderRadius: '20px',
    padding: '6px 12px',
    fontSize: '13px',
    color: isActive ? '#155724' : '#6c757d',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'all 0.2s ease',
});

function OptionChip({ label, priceSuffix, isActive, disabled, onClick, title }) {
    return (
        <button
            className="ingredient-button"
            onClick={onClick}
            disabled={disabled}
            style={chipStyle(isActive, disabled)}
            title={title}
        >
            <span style={{ marginRight: '4px', fontSize: '12px' }}>
                {isActive ? '✓' : '+'}
            </span>
            {label}
            {priceSuffix ? (
                <span style={{ marginLeft: '4px', fontSize: '11px', fontWeight: 'bold', color: '#856404' }}>
                    (+${priceSuffix})
                </span>
            ) : null}
        </button>
    );
}

/**
 * One group of substitution chips.
 *
 * mode 'replace' — exactly one active (protein, sauce, starch). The active chip
 *                  is disabled, since re-selecting it is a no-op.
 * mode 'toggle'  — any number active (veggies, garnishes). Always clickable.
 */
function OptionGroup({ label, options, mode, saving, onSelect }) {
    if (!options || options.length === 0) return null;

    return (
        <div style={{ marginBottom: '15px' }}>
            <label style={{
                display: 'block', marginBottom: '8px',
                fontSize: '14px', fontWeight: 'bold', color: '#555',
            }}>
                {label}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {options.map((opt, i) => {
                    const disabled = saving || (mode === 'replace' && opt.isActive);
                    return (
                        <OptionChip
                            key={opt.id ?? `none-${i}`}
                            label={opt.displayName || opt.name}
                            priceSuffix={opt.price > 0 ? opt.price : null}
                            isActive={opt.isActive}
                            disabled={disabled}
                            onClick={() => { if (!disabled) onSelect(opt); }}
                            title={opt.isActive
                                ? `Current: ${opt.displayName || opt.name}`
                                : `Switch to ${opt.displayName || opt.name}`}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function CompactMealCard({ meal, saving, onOpen, onQuantityChange }) {
    const isAvailable = meal.quantity === 0;

    return (
        <div
            onClick={() => onOpen(meal)}
            className="compact-meal-card"
            style={{
                position: 'relative',
                border: isAvailable ? '2px dashed #ccc' : '1px solid #333',
                borderRadius: '8px',
                padding: '10px',
                cursor: 'pointer',
                backgroundColor: isAvailable ? '#f9f9f9' : '#fafafa',
                transition: 'all 0.2s ease',
                minHeight: '180px',
                display: 'flex',
                flexDirection: 'column',
                width: '280px',
                flexShrink: 0,
                opacity: isAvailable ? 0.8 : 1,
            }}
        >
            {meal.imageUrl && (
                <div style={{
                    width: '100%', aspectRatio: '1 / 1',
                    backgroundImage: `url(${meal.imageUrl})`,
                    backgroundSize: 'cover', backgroundPosition: 'center',
                    borderRadius: '4px', marginBottom: '8px',
                }} />
            )}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', marginBottom: '8px',
                    flexWrap: 'wrap', gap: '4px',
                }}>
                    <div style={{ fontSize: '14px', fontWeight: 'bold', flex: '1 1 auto', minWidth: 0 }}>
                        {meal.itemName}
                        {isAvailable && (
                            <span style={{
                                marginLeft: '6px', fontSize: '10px',
                                backgroundColor: '#e3f2fd', color: '#1976d2',
                                padding: '2px 4px', borderRadius: '3px', fontWeight: 'normal',
                            }}>
                                Available
                            </span>
                        )}
                    </div>
                    {!isAvailable && (
                        <div style={{
                            fontSize: '13px', color: '#007bff', fontWeight: 'bold',
                            textDecoration: 'underline', pointerEvents: 'none', flexShrink: 0,
                        }}>
                            EDIT
                        </div>
                    )}
                </div>

                <div style={{ fontSize: '10px', color: '#666', marginTop: 'auto', lineHeight: 1.2 }}>
                    {meal.ingredients?.length ? meal.ingredients.join(', ') : 'No ingredients listed'}
                </div>

                <div style={{
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', gap: '5px', marginTop: '8px',
                }}>
                    <span style={{ fontSize: '10px', color: '#666' }}>Qty: {meal.quantity}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {!isAvailable && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onQuantityChange(meal, meal.quantity - 1); }}
                                disabled={saving}
                                style={{
                                    padding: '2px 6px', border: '1px solid #dc3545', borderRadius: '3px',
                                    backgroundColor: '#f8f9fa', color: '#dc3545',
                                    cursor: saving ? 'not-allowed' : 'pointer', fontSize: '12px',
                                }}
                            >
                                Remove
                            </button>
                        )}
                        <button
                            onClick={(e) => { e.stopPropagation(); onQuantityChange(meal, meal.quantity + 1); }}
                            disabled={saving}
                            style={{
                                padding: '2px 6px', border: '1px solid #28a745', borderRadius: '3px',
                                backgroundColor: '#f8f9fa', color: '#28a745',
                                cursor: saving ? 'not-allowed' : 'pointer', fontSize: '12px',
                            }}
                        >
                            Add
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MealModal({ meal, saving, onClose, handlers }) {
    if (!meal) return null;

    const isAvailable = meal.quantity === 0;
    const showStarch = meal.starchOptions?.some(o => o.isActive);

    return (
        <div
            className="meal-modal-container"
            style={{
                position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            }}
            onClick={onClose}
        >
            <div
                className="meal-modal"
                style={{
                    backgroundColor: 'white', borderRadius: '8px', maxWidth: '800px',
                    maxHeight: '90vh', overflow: 'auto', margin: '20px', position: 'relative',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute', top: '15px', right: '15px', background: 'none',
                        border: 'none', fontSize: '24px', cursor: 'pointer', zIndex: 1001,
                    }}
                >
                    ×
                </button>

                <div style={{ padding: '20px' }}>
                    <div className="meal-modal-content" style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
                        <div className="meal-modal-image" style={{ flex: '0 0 300px', minHeight: '200px' }}>
                            {meal.imageUrl && (
                                <img
                                    src={meal.imageUrl}
                                    alt={meal.itemName}
                                    style={{ width: '100%', height: '200px', objectFit: 'cover', borderRadius: '8px' }}
                                />
                            )}
                        </div>

                        <div className="meal-modal-details" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px' }}>
                            <h4 style={{ margin: '0 0 5px 0', color: '#333' }}>
                                {meal.itemName}
                                {isAvailable && (
                                    <span style={{
                                        marginLeft: '8px', fontSize: '12px',
                                        backgroundColor: '#e3f2fd', color: '#1976d2',
                                        padding: '2px 6px', borderRadius: '3px',
                                    }}>
                                        Available to Add
                                    </span>
                                )}
                            </h4>

                            {isAvailable ? (
                                <>
                                    <div style={{
                                        backgroundColor: '#e3f2fd', border: '1px solid #bbdefb',
                                        borderRadius: '6px', padding: '12px', fontSize: '14px', color: '#1565c0',
                                    }}>
                                        <strong>Available Dish:</strong> This dish is available for this week but
                                        not currently in your meal plan. Click Add to put it in your orders.
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 'bold', color: '#555' }}>
                                            What's included:
                                        </label>
                                        <div style={{ fontSize: '14px', color: '#666', lineHeight: 1.4 }}>
                                            {meal.ingredients?.length ? meal.ingredients.join(', ') : 'No ingredients listed'}
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <OptionGroup
                                        label="Protein:" mode="replace" saving={saving}
                                        options={meal.proteinOptions?.options}
                                        onSelect={(opt) => handlers.onProtein(meal, opt)}
                                    />
                                    <OptionGroup
                                        label="Veggies:" mode="toggle" saving={saving}
                                        options={meal.veggieOptions}
                                        onSelect={(opt) => handlers.onVeggie(meal, opt)}
                                    />
                                    {showStarch && (
                                        <OptionGroup
                                            label="Starch:" mode="replace" saving={saving}
                                            options={meal.starchOptions}
                                            onSelect={(opt) => handlers.onStarch(meal, opt)}
                                        />
                                    )}
                                    {meal.meal !== 'Snack' && (
                                        <OptionGroup
                                            label="Sauce:" mode="replace" saving={saving}
                                            options={meal.sauceOptions}
                                            onSelect={(opt) => handlers.onSauce(meal, opt)}
                                        />
                                    )}
                                    <OptionGroup
                                        label="Garnish:" mode="toggle" saving={saving}
                                        options={meal.garnishOptions}
                                        onSelect={(opt) => handlers.onGarnish(meal, opt)}
                                    />

                                    {/* Snacks expose a flat ingredient list instead of component groups.
                                        This one endpoint takes a NAME rather than an id. */}
                                    {meal.meal === 'Snack' && meal.allIngredients?.length > 0 && (
                                        <div>
                                            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 'bold', color: '#555' }}>
                                                Ingredients (click to add/remove):
                                            </label>
                                            <div className="ingredient-buttons" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                                {meal.allIngredients.map((ing) => {
                                                    const isActive = meal.ingredients.includes(ing.name);
                                                    return (
                                                        <OptionChip
                                                            key={ing.id}
                                                            label={ing.name}
                                                            isActive={isActive}
                                                            disabled={saving}
                                                            onClick={() => handlers.onNamedIngredient(meal, ing.name, isActive)}
                                                            title={isActive ? `Remove ${ing.name}` : `Add ${ing.name}`}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function PriceConfirmationModal({ confirmData, onConfirm, onCancel }) {
    return (
        <div
            style={{
                position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
            }}
            onClick={onCancel}
        >
            <div
                style={{
                    backgroundColor: 'white', borderRadius: '12px', padding: '30px',
                    maxWidth: '400px', margin: '20px', textAlign: 'center',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <h3 style={{ margin: '0 0 15px 0', color: '#333', fontSize: '18px' }}>
                    Premium Protein Upgrade
                </h3>
                <p style={{ margin: '0 0 20px 0', color: '#666', lineHeight: 1.5 }}>
                    Switching to <strong>{confirmData.proteinName}</strong> will cost an additional{' '}
                    <strong>${confirmData.price}</strong>. You will be charged through invoice.
                </p>
                <p style={{ margin: '0 0 25px 0', fontSize: '14px', color: '#888' }}>Is that okay?</p>
                <div style={{ display: 'flex', gap: '15px', justifyContent: 'center' }}>
                    <button
                        onClick={onCancel}
                        style={{
                            padding: '10px 20px', border: '1px solid #ddd', borderRadius: '6px',
                            backgroundColor: '#f8f9fa', color: '#666', cursor: 'pointer', fontSize: '14px',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        style={{
                            padding: '10px 20px', border: 'none', borderRadius: '6px',
                            backgroundColor: '#007bff', color: 'white', cursor: 'pointer',
                            fontSize: '14px', fontWeight: 'bold',
                        }}
                    >
                        Confirm (+${confirmData.price})
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Horizontal scroller with arrows. Owns its own scroll state via a ref, so
 * scrolling never triggers a parent re-render — the old version pushed scroll
 * position into component state on every scroll event.
 */
function ScrollRow({ mealType, children, count }) {
    const ref = useRef(null);
    const [canLeft, setCanLeft] = useState(false);
    const [canRight, setCanRight] = useState(false);

    const sync = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        setCanLeft(el.scrollLeft > 5);
        setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 5);
    }, []);

    useEffect(() => {
        sync();
        window.addEventListener('resize', sync);
        return () => window.removeEventListener('resize', sync);
    }, [sync, count]);

    const overflows = ref.current
        ? count * CARD_WIDTH > ref.current.clientWidth
        : count > 3;

    const arrow = (dir) => (
        <div
            onClick={() => ref.current?.scrollBy({ left: dir * SCROLL_STEP, behavior: 'smooth' })}
            style={{
                position: 'absolute', top: '50%', [dir < 0 ? 'left' : 'right']: '10px',
                transform: 'translateY(-50%)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', borderRadius: '50%', width: '40px', height: '40px',
                cursor: 'pointer', backgroundColor: '#007bff', color: 'white',
                fontSize: '18px', fontWeight: 'bold',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)', zIndex: 10,
            }}
        >
            {dir < 0 ? '←' : '→'}
        </div>
    );

    return (
        <div style={{ position: 'relative' }}>
            <div
                ref={ref}
                data-meal-type={mealType}
                onScroll={sync}
                style={{ display: 'flex', overflowX: 'auto', gap: '15px', paddingBottom: '10px' }}
            >
                {children}
            </div>
            {overflows && canLeft && arrow(-1)}
            {overflows && canRight && arrow(1)}
        </div>
    );
}

// ===========================================================================
// Container
// ===========================================================================

export default function MealPlanViewer() {
    const [params] = useSearchParams();
    const token = params.get('customer');

    const [plan, setPlan] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState('');

    const [selectedDate, setSelectedDate] = useState(null);
    const [openRecordId, setOpenRecordId] = useState(null);
    const [priceConfirm, setPriceConfirm] = useState(null);

    const flash = useCallback((msg, ms = 2500) => {
        setSuccessMessage(msg);
        setTimeout(() => setSuccessMessage(''), ms);
    }, []);

    /**
     * Single fetch used for both initial load and post-mutation refresh.
     * `silent` skips the loading spinner so the page does not flash on a write.
     */
    const load = useCallback(async (silent = false) => {
        if (!token) { setError('No customer token provided'); setLoading(false); return; }
        try {
            if (!silent) setLoading(true);
            setError(null);
            const { data } = await axios.get(`/orders/${token}`);
            setPlan(data);

            const dates = [...new Set(data.orders.map(o => o.deliveryDate || 'No Date'))]
                .sort((a, b) => (a === 'No Date' ? 1 : b === 'No Date' ? -1 : new Date(a) - new Date(b)));

            // Keep the user's tab selection across a refresh.
            setSelectedDate(prev => (prev && dates.includes(prev) ? prev : dates[0] ?? null));
            return data;
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load meal plan');
            console.error('Error fetching meal plan:', err);
        } finally {
            if (!silent) setLoading(false);
        }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        document.title = plan?.customer?.name
            ? `Square Fare for ${plan.customer.name}`
            : 'Weekly Orders';
    }, [plan?.customer?.name]);

    /**
     * Every mutation funnels through here: run the request, refetch, flash a
     * message. One code path instead of eight hand-rolled state patches.
     */
    const mutate = useCallback(async (fn, successMsg) => {
        try {
            setSaving(true);
            setError(null);
            await fn();
            await load(true);
            if (successMsg) flash(successMsg);
        } catch (err) {
            setError(err.response?.data?.error || 'Update failed');
            console.error('Mutation failed:', err);
            await load(true);   // resync — local view may be mid-change
        } finally {
            setSaving(false);
        }
    }, [load, flash]);

    // ---- individual actions -------------------------------------------

    const onQuantityChange = useCallback((meal, next) => {
        const target = Math.max(0, next);
        if (target === meal.quantity) return;

        if (meal.quantity === 0 && target === 1) {
            return mutate(
                () => axios.post(`/orders/${token}/add-dish`, {
                    dishId: meal.dishId,
                    mealType: meal.meal,
                    requestedDeliveryDate: selectedDate,
                }),
                `Added ${meal.itemName} to your ${meal.meal.toLowerCase()} meals`);
        }

        return mutate(
            () => axios.patch(`/orders/${token}/quantity`, {
                recordId: meal.recordId, newQuantity: target, itemName: meal.itemName,
            }),
            target === 0 ? `Removed ${meal.itemName}` : `Updated ${meal.itemName} servings`);
    }, [mutate, token, selectedDate]);

    const applyProtein = useCallback((meal, opt, price = 0) => mutate(
        () => axios.patch(`/orders/${token}/replace-protein`, {
            recordId: meal.recordId,
            newProteinId: opt.id,
            oldProteinId: meal.proteinOptions?.options?.find(o => o.isActive)?.id ?? null,
            upgradePrice: price,
        }),
        price > 0
            ? `Protein upgraded. An additional $${price} will be added to your invoice.`
            : 'Protein updated'), [mutate, token]);

    const onProtein = useCallback((meal, opt) => {
        if (opt.price > 0) {
            // Confirm before committing a charge.
            setPriceConfirm({
                recordId: meal.recordId,
                option: opt,
                proteinName: opt.displayName || opt.name,
                price: opt.price,
            });
            return;
        }
        applyProtein(meal, opt, 0);
    }, [applyProtein]);

    const onSauce = useCallback((meal, opt) => mutate(
        () => axios.patch(`/orders/${token}/replace-sauce`, {
            recordId: meal.recordId,
            newSauceId: opt.id,                       // null for "No Sauce"
            oldSauceId: meal.sauceOptions?.find(o => o.isActive)?.id ?? null,
        }), 'Sauce updated'), [mutate, token]);

    const onStarch = useCallback((meal, opt) => mutate(
        () => axios.patch(`/orders/${token}/toggle-starch`, {
            recordId: meal.recordId, starchId: opt.id, shouldActivate: true,
        }), 'Starch updated'), [mutate, token]);

    const onVeggie = useCallback((meal, opt) => mutate(
        () => axios.patch(`/orders/${token}/toggle-veggie`, {
            recordId: meal.recordId, veggieId: opt.id, shouldActivate: !opt.isActive,
        }), opt.isActive ? 'Veggie removed' : 'Veggie added'), [mutate, token]);

    const onGarnish = useCallback((meal, opt) => mutate(
        () => axios.patch(`/orders/${token}/toggle-garnish`, {
            recordId: meal.recordId, garnishId: opt.id, shouldActivate: !opt.isActive,
        }), opt.isActive ? 'Garnish removed' : 'Garnish added'), [mutate, token]);

    const onNamedIngredient = useCallback((meal, name, isActive) => mutate(
        () => axios.patch(`/orders/${token}/ingredients/toggle`, {
            recordId: meal.recordId, ingredientName: name, shouldActivate: !isActive,
        }), isActive ? `Removed "${name}"` : `Added "${name}"`), [mutate, token]);

    const handlers = { onProtein, onSauce, onStarch, onVeggie, onGarnish, onNamedIngredient };

    // ---- derived view state -------------------------------------------

    const allOrders = plan?.orders ?? [];
    const dates = [...new Set(allOrders.map(o => o.deliveryDate || 'No Date'))]
        .sort((a, b) => (a === 'No Date' ? 1 : b === 'No Date' ? -1 : new Date(a) - new Date(b)));
    const visible = allOrders.filter(o => (o.deliveryDate || 'No Date') === selectedDate);

    // Ordered dishes first, available ones after.
    const sorted = [...visible.filter(o => o.quantity > 0), ...visible.filter(o => o.quantity === 0)];

    // Read the open card straight out of the current data, so a refetch
    // updates the modal automatically. This is what fixes the stale checkmark.
    const openMeal = openRecordId
        ? allOrders.find(o => o.recordId === openRecordId) ?? null
        : null;

    useEffect(() => {
        // Card was deleted underneath us (quantity dropped to zero).
        if (openRecordId && plan && !openMeal) setOpenRecordId(null);
    }, [openRecordId, openMeal, plan]);

    const subscribedCount = (mealType) =>
        plan?.subscriptions?.find(s =>
            s.meal?.toLowerCase().includes(mealType.toLowerCase()) &&
            s.deliveryDate === selectedDate)?.mealsIncluded ?? 0;

    const orderedCount = (mealType) =>
        visible.filter(o => o.meal === mealType && o.quantity > 0)
               .reduce((n, o) => n + o.quantity, 0);

    const countLabel = (mealType) => {
        const sub = subscribedCount(mealType);
        if (mealType === 'Snack') return `${sub} day${sub === 1 ? '' : 's'} subscribed`;
        return `${sub} meal${sub !== 1 ? 's' : ''} subscribed, ${orderedCount(mealType)} selected`;
    };

    const formatDate = (s) => {
        if (s === 'No Date') return 'No Date';
        try {
            return new Date(s).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
            });
        } catch { return s; }
    };

    // ---- render --------------------------------------------------------

    if (loading) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px', textAlign: 'center' }}>
                <div style={{
                    border: '4px solid #f3f3f3', borderTop: '4px solid #3498db',
                    borderRadius: '50%', width: '40px', height: '40px',
                    animation: 'spin 2s linear infinite', margin: '0 auto 20px',
                }} />
                <p>Loading your meal plan...</p>
                <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    if (error && !plan) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
                <div style={{ backgroundColor: '#fee', border: '1px solid #fcc', borderRadius: '8px', padding: '20px' }}>
                    <h2 style={{ color: '#c33', marginBottom: '10px' }}>Error</h2>
                    <p style={{ color: '#c33' }}>{error}</p>
                    <button
                        onClick={() => load()}
                        style={{
                            marginTop: '15px', padding: '10px 20px', backgroundColor: '#c33',
                            color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer',
                        }}
                    >
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    if (!plan || allOrders.length === 0) {
        return (
            <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px', textAlign: 'center' }}>
                <h2>No Meal Plan Found</h2>
                <p>No meal plan data found for this customer.</p>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
            <div style={{
                backgroundColor: 'white', borderRadius: '8px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.1)', overflow: 'hidden',
            }}>
                <div style={{ borderBottom: '1px solid #eee', padding: '20px', backgroundColor: '#f8f9fa' }}>
                    <h1 style={{ margin: '0 0 5px 0', color: '#333' }}>Personalized Meal Plan</h1>
                    <p style={{ margin: 0, color: '#666' }}>
                        {plan.customer.name} • {plan.customer.email}
                    </p>
                </div>

                {successMessage && (
                    <div style={{
                        margin: '20px', backgroundColor: '#dff0d8', border: '1px solid #d6e9c6',
                        borderRadius: '5px', padding: '15px', color: '#3c763d',
                    }}>
                        {successMessage}
                    </div>
                )}

                {error && (
                    <div style={{
                        margin: '20px', backgroundColor: '#f2dede', border: '1px solid #ebccd1',
                        borderRadius: '5px', padding: '15px', color: '#a94442',
                    }}>
                        {error}
                    </div>
                )}

                {dates.length > 1 && (
                    <div style={{ padding: '0 20px 20px', borderBottom: '1px solid #eee', marginBottom: '20px' }}>
                        <h4 style={{ marginBottom: '15px', color: '#333', fontSize: '16px' }}>Delivery Dates</h4>
                        <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '5px' }}>
                            {dates.map(date => {
                                const active = selectedDate === date;
                                return (
                                    <button
                                        key={date}
                                        onClick={() => setSelectedDate(date)}
                                        style={{
                                            padding: '8px 16px',
                                            border: active ? '2px solid #007bff' : '1px solid #ddd',
                                            borderRadius: '20px',
                                            backgroundColor: active ? '#007bff' : '#fff',
                                            color: active ? '#fff' : '#333',
                                            cursor: 'pointer', fontSize: '14px',
                                            fontWeight: active ? 'bold' : 'normal',
                                            whiteSpace: 'nowrap', transition: 'all 0.2s ease',
                                        }}
                                    >
                                        {formatDate(date)}
                                        <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>
                                            ({allOrders.filter(o =>
                                                (o.deliveryDate || 'No Date') === date && o.quantity > 0).length})
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div style={{ padding: '20px' }}>
                    <h3 style={{ marginBottom: '20px' }}>Your Meals</h3>

                    {MEAL_TYPES.map(mealType => {
                        const rows = sorted.filter(o => o.meal === mealType);
                        if (rows.length === 0) return null;

                        return (
                            <div key={mealType} style={{ marginBottom: '30px' }}>
                                <h4 style={{
                                    color: '#333', marginBottom: '15px',
                                    paddingBottom: '5px', borderBottom: '2px solid #eee',
                                }}>
                                    {mealType}
                                    <span style={{ fontSize: '14px', color: '#666', fontWeight: 'normal', marginLeft: '8px' }}>
                                        ({countLabel(mealType)})
                                    </span>
                                </h4>

                                <ScrollRow mealType={mealType} count={rows.length}>
                                    {rows.map(order => (
                                        <CompactMealCard
                                            key={order.recordId || `${order.dishId}-${order.meal}`}
                                            meal={order}
                                            saving={saving}
                                            onOpen={(m) => setOpenRecordId(m.recordId)}
                                            onQuantityChange={onQuantityChange}
                                        />
                                    ))}
                                </ScrollRow>
                            </div>
                        );
                    })}
                </div>
            </div>

            {openMeal && (
                <MealModal
                    meal={openMeal}
                    saving={saving}
                    onClose={() => setOpenRecordId(null)}
                    handlers={handlers}
                />
            )}

            {priceConfirm && (
                <PriceConfirmationModal
                    confirmData={priceConfirm}
                    onCancel={() => setPriceConfirm(null)}
                    onConfirm={() => {
                        const meal = allOrders.find(o => o.recordId === priceConfirm.recordId);
                        setPriceConfirm(null);
                        if (meal) applyProtein(meal, priceConfirm.option, priceConfirm.price);
                    }}
                />
            )}
        </div>
    );
}