/**
 * Billing configuration
 * Plan limits and Stripe price mappings
 */

const PLAN_CONFIG = {
  free: { credits: 2, chatLimit: 30, priceId: null },
  student: { credits: 8, chatLimit: 150, priceId: process.env.STRIPE_PRICE_STUDENT },
  teacher: { credits: 30, chatLimit: null, priceId: process.env.STRIPE_PRICE_TEACHER },  // unlimited chat
  studio: { credits: 80, chatLimit: null, priceId: process.env.STRIPE_PRICE_STUDIO },    // unlimited chat
};

const TOPUP_CONFIG = {
  5: { priceId: process.env.STRIPE_PRICE_TOPUP_5 },
  15: { priceId: process.env.STRIPE_PRICE_TOPUP_15 },
};

// Reverse lookup: price ID → tier
const getPriceToTierMap = () => ({
  [process.env.STRIPE_PRICE_STUDENT]: 'student',
  [process.env.STRIPE_PRICE_TEACHER]: 'teacher',
  [process.env.STRIPE_PRICE_STUDIO]: 'studio',
});

// Reverse lookup: price ID → topup credits
const getPriceToTopupMap = () => ({
  [process.env.STRIPE_PRICE_TOPUP_5]: 5,
  [process.env.STRIPE_PRICE_TOPUP_15]: 15,
});

module.exports = {
  PLAN_CONFIG,
  TOPUP_CONFIG,
  getPriceToTierMap,
  getPriceToTopupMap,
};
