/**
 * Billing Routes
 * Handles Stripe webhooks and billing API endpoints
 */

const express = require('express');
const Stripe = require('stripe');
const httpStatus = require('http-status');
const { supabaseAuth } = require('../../middlewares/supabaseAuth');
const billingService = require('../../services/billing.service');
const { PLAN_CONFIG, TOPUP_CONFIG, getPriceToTierMap, getPriceToTopupMap } = require('../../config/billing');

const router = express.Router();

// Initialize Stripe (lazy - only when needed)
let stripe = null;
const getStripe = () => {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
};

// ============================================
// WEBHOOK ENDPOINT (no auth - Stripe signature verification)
// ============================================

/**
 * Stripe webhook handler
 * POST /v1/billing/webhook
 *
 * Note: Raw body parsing is handled in app.js before express.json()
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    console.error('Webhook: Missing stripe-signature header');
    return res.status(400).send('Missing signature');
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Webhook received: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionChange(event.data.object);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`Webhook handler error for ${event.type}:`, error);
    // Return 200 to prevent Stripe from retrying - we've logged the error
    res.json({ received: true, error: error.message });
  }
});

/**
 * Handle checkout.session.completed
 * - New subscriptions: Link Stripe customer to user
 * - Top-ups: Add credits to user
 */
async function handleCheckoutComplete(session) {
  const userId = session.client_reference_id;
  const customerId = session.customer;

  if (!userId) {
    console.error('Checkout session missing client_reference_id');
    return;
  }

  console.log(`Checkout completed for user ${userId}, mode: ${session.mode}`);

  if (session.mode === 'subscription') {
    // New subscription - link Stripe customer to user
    // Tier/credits will be set by invoice.paid event
    await billingService.updateBillingState(userId, {
      stripe_customer_id: customerId,
    });
    console.log(`Linked Stripe customer ${customerId} to user ${userId}`);

  } else if (session.mode === 'payment') {
    // Top-up purchase
    const lineItems = await getStripe().checkout.sessions.listLineItems(session.id);
    const priceId = lineItems.data[0]?.price?.id;
    const topupMap = getPriceToTopupMap();
    const credits = topupMap[priceId];

    if (credits) {
      await billingService.addTopupCredits(userId, credits);
      console.log(`Added ${credits} top-up credits to user ${userId}`);
    } else {
      console.error(`Unknown top-up price ID: ${priceId}`);
    }
  }
}

/**
 * Handle subscription updated/deleted
 * - Updates tier and status
 */
async function handleSubscriptionChange(subscription) {
  const customerId = subscription.customer;
  const priceId = subscription.items.data[0]?.price?.id;
  const tierMap = getPriceToTierMap();

  // Determine new tier
  let tier;
  if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
    tier = 'free';
  } else {
    tier = tierMap[priceId] || 'free';
  }

  // Map Stripe status to our status
  let status;
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    status = 'active';
  } else if (subscription.status === 'past_due') {
    status = 'past_due';
  } else {
    status = 'canceled';
  }

  const result = await billingService.updateByStripeCustomerId(customerId, { tier, status });

  if (result) {
    console.log(`Updated subscription for customer ${customerId}: tier=${tier}, status=${status}`);
  } else {
    console.error(`Failed to update subscription - customer ${customerId} not found`);
  }
}

/**
 * Handle invoice.paid
 * - Resets credits for new billing period
 */
async function handleInvoicePaid(invoice) {
  // Only handle subscription cycle/create invoices
  if (invoice.billing_reason !== 'subscription_cycle' &&
      invoice.billing_reason !== 'subscription_create') {
    return;
  }

  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;

  if (!subscriptionId) {
    return;
  }

  // Get subscription details
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  const tierMap = getPriceToTierMap();
  const tier = tierMap[priceId];

  if (!tier) {
    console.error(`Unknown price ID in invoice: ${priceId}`);
    return;
  }

  const config = PLAN_CONFIG[tier];
  const periodEnd = new Date(subscription.current_period_end * 1000);

  const result = await billingService.updateByStripeCustomerId(customerId, {
    tier,
    status: 'active',
    plan_credits: config.credits,
    chat_count: 0,
    period_end: periodEnd.toISOString(),
  });

  if (result) {
    console.log(`Reset credits for customer ${customerId}: tier=${tier}, credits=${config.credits}`);
  } else {
    console.error(`Failed to reset credits - customer ${customerId} not found`);
  }
}

// ============================================
// AUTHENTICATED API ENDPOINTS
// ============================================

/**
 * Get current billing state
 * GET /v1/billing
 */
router.get('/', supabaseAuth(), async (req, res, next) => {
  try {
    let state = await billingService.getBillingState(req.user.id);
    state = await billingService.ensureFreshPeriod(req.user.id, state);

    const config = PLAN_CONFIG[state.tier] || PLAN_CONFIG.free;
    const isUnlimitedChat = config.chatLimit === null;

    res.json({
      tier: state.tier,
      status: state.status,
      credits: {
        plan: state.plan_credits,
        topup: state.topup_credits,
        total: state.plan_credits + state.topup_credits,
      },
      chat: {
        used: state.chat_count,
        limit: isUnlimitedChat ? null : config.chatLimit,
        remaining: isUnlimitedChat ? null : (config.chatLimit - state.chat_count),
        unlimited: isUnlimitedChat,
      },
      periodEnd: state.period_end,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Create checkout session for upgrade or top-up
 * POST /v1/billing/checkout
 * Body: { tier?: string, topup?: number }
 */
router.post('/checkout', supabaseAuth(), async (req, res, next) => {
  try {
    const { tier, topup } = req.body;
    const userId = req.user.id;

    if (!tier && !topup) {
      return res.status(400).json({ error: 'Either tier or topup is required' });
    }

    let state = await billingService.getBillingState(userId);

    // Create Stripe customer if needed
    if (!state.stripe_customer_id) {
      const customer = await getStripe().customers.create({
        email: req.user.email,
        metadata: { user_id: userId },
      });
      await billingService.updateBillingState(userId, {
        stripe_customer_id: customer.id,
      });
      state.stripe_customer_id = customer.id;
    }

    // Determine price ID
    let priceId;
    let mode;

    if (topup) {
      const topupConfig = TOPUP_CONFIG[topup];
      if (!topupConfig?.priceId) {
        return res.status(400).json({ error: 'Invalid topup amount' });
      }
      priceId = topupConfig.priceId;
      mode = 'payment';
    } else {
      const planConfig = PLAN_CONFIG[tier];
      if (!planConfig?.priceId) {
        return res.status(400).json({ error: 'Invalid tier' });
      }
      priceId = planConfig.priceId;
      mode = 'subscription';
    }

    const appUrl = process.env.APP_URL || 'https://arco.app/start';

    const session = await getStripe().checkout.sessions.create({
      customer: state.stripe_customer_id,
      client_reference_id: userId,
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}?billing=success`,
      cancel_url: `${appUrl}?billing=canceled`,
    });

    res.json({ url: session.url });
  } catch (error) {
    next(error);
  }
});

/**
 * Get Customer Portal URL
 * POST /v1/billing/portal
 */
router.post('/portal', supabaseAuth(), async (req, res, next) => {
  try {
    const state = await billingService.getBillingState(req.user.id);

    if (!state.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account' });
    }

    const appUrl = process.env.APP_URL || 'https://arco.app/start';

    const session = await getStripe().billingPortal.sessions.create({
      customer: state.stripe_customer_id,
      return_url: appUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
