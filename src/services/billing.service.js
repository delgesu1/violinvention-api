/**
 * Billing Service
 * Handles credit management, subscription state, and chat limits
 */

const { supabase } = require('../config/supabase');
const { PLAN_CONFIG } = require('../config/billing');

/**
 * Get or create billing state for a user
 * @param {string} userId - User ID from Supabase Auth
 * @returns {Promise<Object>} Billing state
 */
const getBillingState = async (userId) => {
  // Try to get existing billing state
  let { data, error } = await supabase
    .from('billing_state')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code === 'PGRST116') {
    // No row found - create one with free tier defaults
    const { data: newData, error: insertError } = await supabase
      .from('billing_state')
      .insert({
        user_id: userId,
        tier: 'free',
        status: 'active',
        plan_credits: PLAN_CONFIG.free.credits,
        topup_credits: 0,
        chat_count: 0,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating billing state:', insertError);
      throw new Error('Failed to create billing state');
    }
    data = newData;
  } else if (error) {
    console.error('Error fetching billing state:', error);
    throw new Error('Failed to fetch billing state');
  }

  return data;
};

/**
 * Lazy reset for free tier - resets credits at start of new month
 * @param {string} userId - User ID
 * @param {Object} state - Current billing state
 * @returns {Promise<Object>} Updated billing state
 */
const ensureFreshPeriod = async (userId, state) => {
  // Only free tier uses lazy resets; paid tiers reset via invoice webhook
  if (state.tier !== 'free') {
    return state;
  }

  const now = new Date();
  const needsReset = !state.period_end || new Date(state.period_end) < now;

  if (!needsReset) {
    return state;
  }

  // Calculate end of current month
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const { data, error } = await supabase
    .from('billing_state')
    .update({
      plan_credits: PLAN_CONFIG.free.credits,
      chat_count: 0,
      period_end: periodEnd.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error resetting free tier period:', error);
    throw new Error('Failed to reset billing period');
  }

  return data;
};

/**
 * Check if user has access (credits or chat)
 * @param {string} userId - User ID
 * @param {'credit' | 'chat'} type - Type of access to check
 * @returns {Promise<{allowed: boolean, state: Object, warning?: {remaining: number}, unlimited?: boolean}>}
 */
const checkAccess = async (userId, type) => {
  let state = await getBillingState(userId);
  state = await ensureFreshPeriod(userId, state);

  const config = PLAN_CONFIG[state.tier] || PLAN_CONFIG.free;

  if (type === 'credit') {
    const total = state.plan_credits + state.topup_credits;
    return { allowed: total > 0, state };
  }

  // Chat check - null chatLimit means unlimited (teacher/studio tiers)
  if (config.chatLimit === null) {
    return { allowed: true, state, unlimited: true };
  }

  const allowed = state.chat_count < config.chatLimit;
  const remaining = config.chatLimit - state.chat_count;
  const warning = remaining <= 20 ? { remaining } : undefined;

  return { allowed, state, warning };
};

/**
 * Consume a credit (for lessons/deep dives)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated billing state
 */
const consumeCredit = async (userId) => {
  let state = await getBillingState(userId);
  state = await ensureFreshPeriod(userId, state);

  const total = state.plan_credits + state.topup_credits;
  if (total <= 0) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  // Deduct from plan first, then topup
  const updates = { updated_at: new Date().toISOString() };

  if (state.plan_credits > 0) {
    updates.plan_credits = state.plan_credits - 1;
  } else {
    updates.topup_credits = state.topup_credits - 1;
  }

  const { data, error } = await supabase
    .from('billing_state')
    .update(updates)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error consuming credit:', error);
    throw new Error('Failed to consume credit');
  }

  return data;
};

/**
 * Increment chat count
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
const incrementChat = async (userId) => {
  const { error } = await supabase.rpc('increment_chat_count', { p_user_id: userId });

  if (error) {
    console.error('Error incrementing chat count:', error);
    throw new Error('Failed to increment chat count');
  }
};

/**
 * Add top-up credits
 * @param {string} userId - User ID
 * @param {number} credits - Number of credits to add
 * @returns {Promise<void>}
 */
const addTopupCredits = async (userId, credits) => {
  const { error } = await supabase.rpc('add_topup_credits', {
    p_user_id: userId,
    p_credits: credits
  });

  if (error) {
    console.error('Error adding topup credits:', error);
    throw new Error('Failed to add topup credits');
  }
};

/**
 * Update billing state from Stripe subscription
 * @param {string} stripeCustomerId - Stripe customer ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>} Updated billing state or null if not found
 */
const updateByStripeCustomerId = async (stripeCustomerId, updates) => {
  const { data, error } = await supabase
    .from('billing_state')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', stripeCustomerId)
    .select()
    .single();

  if (error) {
    console.error('Error updating billing state by Stripe customer ID:', error);
    return null;
  }

  return data;
};

/**
 * Update billing state for a user
 * @param {string} userId - User ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated billing state
 */
const updateBillingState = async (userId, updates) => {
  const { data, error } = await supabase
    .from('billing_state')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error updating billing state:', error);
    throw new Error('Failed to update billing state');
  }

  return data;
};

/**
 * Get billing state by Stripe customer ID
 * @param {string} stripeCustomerId - Stripe customer ID
 * @returns {Promise<Object|null>} Billing state or null
 */
const getByStripeCustomerId = async (stripeCustomerId) => {
  const { data, error } = await supabase
    .from('billing_state')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (error) {
    return null;
  }

  return data;
};

module.exports = {
  getBillingState,
  ensureFreshPeriod,
  checkAccess,
  consumeCredit,
  incrementChat,
  addTopupCredits,
  updateByStripeCustomerId,
  updateBillingState,
  getByStripeCustomerId,
};
