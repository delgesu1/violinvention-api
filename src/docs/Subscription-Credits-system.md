# Final Implementation Plan - Option C: Smart MVP (Production-Ready, Complexity-Optimized)

## Core Philosophy
Keep production-critical components (audit trail, idempotency, billing cycles), defer analytics until needed.

---

## Database Schema: 9 Tables (8 new + 1 modified)

### Reference Data

**1. subscription_plans**
```sql
id (uuid PK),
plan_key (text unique),
display_name (text),
monthly_price_usd (numeric),
monthly_credits (integer),
tier_level (integer),
stripe_price_id (text),
is_active (boolean)
```
Seeds: Free (100 credits), Lite (500/$5.99), Pro (1600/$15.99), Studio (3500/$29.99), Beta (1500/$0)

**2. credit_packs**
```sql
id (uuid PK),
pack_key (text unique),
display_name (text),
credits_amount (integer),
price_usd (numeric),
stripe_product_id (text),
is_active (boolean),
sort_order (integer)
```
Seeds: 100/$1.49, 500/$5.99, 1000/$10.99

**3. credit_costs**
```sql
id (uuid PK),
operation_type (text unique),
credits_required (integer),
is_active (boolean),
effective_from (timestamptz)
```
Seeds: recording_processing (50), chat_detailed (25), chat_short (5)

---

### User State

**4. users** - Add column:
```sql
is_beta_user boolean DEFAULT false
```

**5. user_subscriptions**
```sql
id (uuid PK),
user_id (uuid FK → users, unique),
subscription_plan_id (uuid FK → subscription_plans),
status (text CHECK: active|past_due|cancelled|expired),
current_period_start (timestamptz),
current_period_end (timestamptz),
cancel_at_period_end (boolean),
payment_provider (text),
external_subscription_id (text),
external_customer_id (text),
stripe_period_end (timestamptz),  -- ADDED: log actual Stripe period for future reconciliation
created_at, updated_at
```

**6. user_credits** - Materialized balance (performance cache)
```sql
id (uuid PK),
user_id (uuid FK → users, unique),
plan_credits (integer ≥0),
topup_credits (integer ≥0),
updated_at (timestamptz)
```

---

### Audit & History

**7. subscription_cycles** - Billing period tracking
```sql
id (uuid PK),
user_id (uuid FK → users),
subscription_plan_id (uuid FK → subscription_plans),
cycle_start_at (timestamptz),
cycle_end_at (timestamptz),
plan_credits_allocated (integer),
plan_credits_consumed (integer),
status (text CHECK: active|completed|cancelled),
ledger_deposit_id (uuid FK → credit_ledger),
created_at, updated_at
```

**8. credit_ledger** - Append-only source of truth
```sql
id (uuid PK),
user_id (uuid FK → users),
entry_type (text: cycle_grant|cycle_expiry|topup_grant|consumption|manual_adjustment|refund),
amount (integer - can be negative),
balance_after (integer),
plan_credits_delta (integer),
topup_credits_delta (integer),
source_type (text),
source_id (uuid),
description (text),
metadata (jsonb),  -- IMPORTANT: Store usage_type, recording_id, chat_id for future analytics
created_at (timestamptz)
```

**9. credit_topups** - One-time purchases
```sql
id (uuid PK),
user_id (uuid FK → users),
credit_pack_id (uuid FK → credit_packs),
credits_purchased (integer),
price_paid_usd (numeric),
payment_provider (text),
external_payment_id (text UNIQUE),  -- UNIQUE constraint for idempotency
status (text CHECK: pending|completed|failed|refunded),
ledger_deposit_id (uuid FK → credit_ledger),
created_at (timestamptz)
```

---

## Design Decisions (Option C Rationale)

✅ **Kept: subscription_cycles** - Valuable for billing period queries ("January usage"), customer support
✅ **Kept: credit_ledger** - Non-negotiable for disputes and audit trail
✅ **Kept: Idempotency guards** - Prevents double-charging (production critical)
  - Subscription renewals: `FOR UPDATE` lock + period_end check
  - Topup grants: `status='completed'` check in function
  - Webhook topups: UNIQUE constraint on `external_payment_id` + lookup-before-insert
✅ **Kept: Separate plan/topup buckets** - Core requirement

⏸️ **Deferred: Billing drift prevention** - Acceptable <500 users; `stripe_period_end` logged for future fix
⏸️ **Deferred: feature_usage table** - Analytics embedded in `ledger.metadata`; can backfill later
⏸️ **Deferred: Reconciliation job** - Manual spot checks sufficient at small scale

❌ **Removed: feature_usage table** - Usage analytics now stored in `credit_ledger.metadata`
❌ **Simplified: Date passing** - `create_subscription_cycle` uses NOW() instead of exact dates (accepts minor drift)

---

## Database Functions (5 Functions)

### 1. create_subscription_cycle(p_user_id, p_subscription_plan_id, p_closing_cycle_id)

**Simplified: Uses NOW() for cycle boundaries (accepts drift)**

```sql
CREATE OR REPLACE FUNCTION create_subscription_cycle(
  p_user_id uuid,
  p_subscription_plan_id uuid,
  p_closing_cycle_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan_credits integer;
  v_leftover_plan integer;
  v_topup integer;
  v_balance_after_expiry integer;
  v_cycle_id uuid;
  v_new_balance integer;
  v_ledger_id uuid;
BEGIN
  -- Get plan details
  SELECT monthly_credits INTO v_plan_credits
  FROM subscription_plans
  WHERE id = p_subscription_plan_id;

  -- Get balances atomically
  SELECT plan_credits, topup_credits INTO v_leftover_plan, v_topup
  FROM user_credits WHERE user_id = p_user_id FOR UPDATE;

  -- Expire unused plan credits (skip if new user)
  IF p_closing_cycle_id IS NOT NULL AND v_leftover_plan > 0 THEN
    v_balance_after_expiry := v_topup;  -- Plan bucket zeroed, only topup remains

    INSERT INTO credit_ledger (user_id, entry_type, amount, balance_after,
                               plan_credits_delta, topup_credits_delta,
                               source_type, source_id, description)
    VALUES (p_user_id, 'cycle_expiry', -v_leftover_plan, v_balance_after_expiry,
            -v_leftover_plan, 0,
            'subscription_cycle', p_closing_cycle_id,
            'Expired unused plan credits from previous cycle');

    UPDATE user_credits SET plan_credits = 0 WHERE user_id = p_user_id;
  END IF;

  -- Create new cycle (SIMPLIFIED: use NOW() instead of passed dates)
  INSERT INTO subscription_cycles (user_id, subscription_plan_id,
                                   cycle_start_at, cycle_end_at,
                                   plan_credits_allocated, plan_credits_consumed, status)
  VALUES (p_user_id, p_subscription_plan_id,
          NOW(), NOW() + INTERVAL '1 month',
          v_plan_credits, 0, 'active')
  RETURNING id INTO v_cycle_id;

  -- Grant new credits
  v_new_balance := v_topup + v_plan_credits;

  INSERT INTO credit_ledger (user_id, entry_type, amount, balance_after,
                             plan_credits_delta, topup_credits_delta,
                             source_type, source_id, description)
  VALUES (p_user_id, 'cycle_grant', v_plan_credits, v_new_balance,
          v_plan_credits, 0,
          'subscription_cycle', v_cycle_id,
          'Monthly cycle credit allocation')
  RETURNING id INTO v_ledger_id;

  -- Update user_credits
  UPDATE user_credits
  SET plan_credits = v_plan_credits, updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Link cycle to ledger
  UPDATE subscription_cycles
  SET ledger_deposit_id = v_ledger_id
  WHERE id = v_cycle_id;

  RETURN v_cycle_id;
END;
$$;
```

---

### 2. deduct_credits(p_user_id, p_amount, p_usage_type, p_ref_type, p_ref_id)

**Modified: Logs usage info in metadata instead of feature_usage table**

```sql
CREATE OR REPLACE FUNCTION deduct_credits(
  p_user_id uuid,
  p_amount integer,
  p_usage_type text,
  p_ref_type text,
  p_ref_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan integer;
  v_topup integer;
  v_total integer;
  v_cycle_id uuid;
  v_plan_deduction integer;
  v_topup_deduction integer;
  v_new_balance integer;
  v_ledger_id uuid;
BEGIN
  -- Lock and check balance
  SELECT plan_credits, topup_credits INTO v_plan, v_topup
  FROM user_credits WHERE user_id = p_user_id FOR UPDATE;

  v_total := v_plan + v_topup;

  IF v_total < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient credits');
  END IF;

  -- Get active cycle
  SELECT id INTO v_cycle_id FROM subscription_cycles
  WHERE user_id = p_user_id AND status = 'active'
  ORDER BY cycle_start_at DESC LIMIT 1;

  -- Calculate split (plan first, then topup)
  v_plan_deduction := LEAST(v_plan, p_amount);
  v_topup_deduction := p_amount - v_plan_deduction;
  v_new_balance := v_total - p_amount;

  -- Insert ledger entry with usage info in metadata (NO feature_usage table)
  INSERT INTO credit_ledger (user_id, entry_type, amount, balance_after,
                             plan_credits_delta, topup_credits_delta,
                             source_type, source_id, description, metadata)
  VALUES (p_user_id, 'consumption', -p_amount, v_new_balance,
          -v_plan_deduction, -v_topup_deduction,
          p_ref_type, p_ref_id,
          'Credit consumption: ' || p_usage_type,
          json_build_object(
            'usage_type', p_usage_type,
            'reference_type', p_ref_type,
            'reference_id', p_ref_id,
            'plan_consumed', v_plan_deduction,
            'topup_consumed', v_topup_deduction
          ))
  RETURNING id INTO v_ledger_id;

  -- Update user_credits
  UPDATE user_credits
  SET plan_credits = plan_credits - v_plan_deduction,
      topup_credits = topup_credits - v_topup_deduction,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Update cycle consumption
  UPDATE subscription_cycles
  SET plan_credits_consumed = plan_credits_consumed + v_plan_deduction
  WHERE id = v_cycle_id;

  RETURN json_build_object(
    'success', true,
    'transaction_id', v_ledger_id,
    'remaining_balance', v_new_balance
  );
END;
$$;
```

---

### 3. grant_topup_credits(p_topup_id)

```sql
CREATE OR REPLACE FUNCTION grant_topup_credits(p_topup_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_credits integer;
  v_status text;
  v_plan integer;
  v_topup integer;
  v_new_balance integer;
  v_ledger_id uuid;
BEGIN
  -- Lock topup row and verify not already processed (idempotency)
  SELECT user_id, credits_purchased, status
  INTO v_user_id, v_credits, v_status
  FROM credit_topups WHERE id = p_topup_id FOR UPDATE;

  IF v_status = 'completed' THEN
    RAISE NOTICE 'Topup already processed, skipping';
    RETURN; -- Idempotent
  END IF;

  -- Get current balance (both buckets in single query with lock)
  SELECT plan_credits, topup_credits INTO v_plan, v_topup
  FROM user_credits WHERE user_id = v_user_id FOR UPDATE;

  v_new_balance := v_plan + v_topup + v_credits;

  -- Insert ledger entry
  INSERT INTO credit_ledger (user_id, entry_type, amount, balance_after,
                             plan_credits_delta, topup_credits_delta,
                             source_type, source_id, description)
  VALUES (v_user_id, 'topup_grant', v_credits, v_new_balance,
          0, v_credits,
          'credit_topup', p_topup_id, 'Credit pack purchase')
  RETURNING id INTO v_ledger_id;

  -- Update user_credits
  UPDATE user_credits
  SET topup_credits = topup_credits + v_credits, updated_at = NOW()
  WHERE user_id = v_user_id;

  -- Mark topup completed and link to ledger
  UPDATE credit_topups
  SET status = 'completed', ledger_deposit_id = v_ledger_id
  WHERE id = p_topup_id;
END;
$$;
```

---

### 4. get_user_balance(p_user_id)

```sql
CREATE OR REPLACE FUNCTION get_user_balance(p_user_id uuid)
RETURNS TABLE(plan_credits integer, topup_credits integer, total_available integer)
LANGUAGE sql
STABLE
AS $$
  SELECT plan_credits, topup_credits, (plan_credits + topup_credits) as total_available
  FROM user_credits WHERE user_id = p_user_id;
$$;
```

---

### 5. renew_subscription_cycle(p_user_id)

**Simplified: No date passing, uses NOW()**

```sql
CREATE OR REPLACE FUNCTION renew_subscription_cycle(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan_id uuid;
  v_period_end timestamptz;
  v_closing_cycle_id uuid;
  v_new_cycle_id uuid;
BEGIN
  -- Lock subscription row
  SELECT subscription_plan_id, current_period_end
  INTO v_plan_id, v_period_end
  FROM user_subscriptions
  WHERE user_id = p_user_id AND status = 'active'
  FOR UPDATE;

  -- Idempotency check: only renew if period has ended
  -- Use > (not >=) so renewals AT the exact boundary succeed
  -- Duplicate webhooks are blocked because current_period_end gets bumped forward after first renewal
  IF v_period_end > NOW() THEN
    RAISE NOTICE 'Subscription not yet due for renewal (ends at %), skipping', v_period_end;
    RETURN NULL;  -- Already renewed or not yet time
  END IF;

  -- Get closing cycle ID before marking completed
  SELECT id INTO v_closing_cycle_id FROM subscription_cycles
  WHERE user_id = p_user_id AND status = 'active'
  ORDER BY cycle_start_at DESC LIMIT 1;

  -- Close current cycle
  UPDATE subscription_cycles SET status = 'completed'
  WHERE user_id = p_user_id AND status = 'active';

  -- Create new cycle (simplified signature - no date params)
  v_new_cycle_id := create_subscription_cycle(p_user_id, v_plan_id, v_closing_cycle_id);

  -- Update subscription period (SIMPLIFIED: use NOW())
  UPDATE user_subscriptions
  SET current_period_start = NOW(),
      current_period_end = NOW() + INTERVAL '1 month'
      -- stripe_period_end stays as-is (logged from webhook for future reconciliation)
  WHERE user_id = p_user_id;

  RETURN v_new_cycle_id;
END;
$$;
```

---

## Triggers

### Initialize New Users

```sql
CREATE OR REPLACE FUNCTION initialize_user_credits_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan_id uuid;
BEGIN
  -- Determine plan (Beta if is_beta_user, else Free)
  IF NEW.is_beta_user THEN
    SELECT id INTO v_plan_id FROM subscription_plans WHERE plan_key = 'beta';
  ELSE
    SELECT id INTO v_plan_id FROM subscription_plans WHERE plan_key = 'free';
  END IF;

  -- Create subscription
  INSERT INTO user_subscriptions (
    user_id, subscription_plan_id, status,
    current_period_start, current_period_end,
    payment_provider
  )
  VALUES (
    NEW.id, v_plan_id, 'active',
    NOW(), NOW() + INTERVAL '1 month',
    'manual'
  );

  -- Create empty credits record
  INSERT INTO user_credits (user_id, plan_credits, topup_credits)
  VALUES (NEW.id, 0, 0);

  -- Create first cycle (no closing cycle for new users)
  PERFORM create_subscription_cycle(NEW.id, v_plan_id, NULL);

  RETURN NEW;
END;
$$;

CREATE TRIGGER after_user_created
AFTER INSERT ON users FOR EACH ROW
EXECUTE FUNCTION initialize_user_credits_subscription();
```

---

## Backend Services

### New: src/services/credits.service.js

```javascript
const { supabase } = require('../config/supabase');
const ApiError = require('../utils/ApiError');

const checkCreditsAvailable = async (userId, operationType) => {
  // Get required credits for operation
  const { data: cost } = await supabase
    .from('credit_costs')
    .select('credits_required')
    .eq('operation_type', operationType)
    .eq('is_active', true)
    .single();

  if (!cost) {
    throw new ApiError(500, `Unknown operation type: ${operationType}`);
  }

  // Get user balance
  const { data: balance } = await supabase
    .rpc('get_user_balance', { p_user_id: userId })
    .single();

  return balance.total_available >= cost.credits_required;
};

const deductCredits = async (userId, operationType, referenceType, referenceId) => {
  // Get required credits
  const { data: cost } = await supabase
    .from('credit_costs')
    .select('credits_required')
    .eq('operation_type', operationType)
    .eq('is_active', true)
    .single();

  // Call deduct function
  const { data: result } = await supabase
    .rpc('deduct_credits', {
      p_user_id: userId,
      p_amount: cost.credits_required,
      p_usage_type: operationType,
      p_ref_type: referenceType,
      p_ref_id: referenceId
    });

  if (!result.success) {
    throw new ApiError(402, result.error);
  }

  return result;
};

const getUserBalance = async (userId) => {
  const { data } = await supabase
    .rpc('get_user_balance', { p_user_id: userId })
    .single();

  return data;
};

const getCreditHistory = async (userId, { limit = 50, offset = 0 }) => {
  const { data, count } = await supabase
    .from('credit_ledger')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return { transactions: data, total: count };
};

module.exports = {
  checkCreditsAvailable,
  deductCredits,
  getUserBalance,
  getCreditHistory
};
```

---

### Modified: src/services/message.service.js

```javascript
const creditsService = require('./credits.service');

// Before processing message
const processMessage = async (userId, chatId, message, detailedMode) => {
  // Determine chat mode
  const chatMode = detailedMode ? 'chat_detailed' : 'chat_short';

  // Check credits
  const hasCredits = await creditsService.checkCreditsAvailable(userId, chatMode);
  if (!hasCredits) {
    throw new ApiError(402, 'Insufficient credits');
  }

  // Process message (existing logic)
  const response = await openai.chat.completions.create(...);

  // Deduct credits after successful processing
  await creditsService.deductCredits(userId, chatMode, 'chat', chatId);

  return response;
};
```

---

## Webhook Integration

### src/controllers/webhooks.controller.js

```javascript
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/supabase');

const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(
    req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
  );

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      // Find user by Stripe customer ID
      const { data: subscription } = await supabase
        .from('user_subscriptions')
        .select('user_id')
        .eq('external_customer_id', customerId)
        .single();

      if (subscription) {
        // Renew subscription cycle
        await supabase.rpc('renew_subscription_cycle', {
          p_user_id: subscription.user_id
        });

        // IMPORTANT: Log actual Stripe period for future reconciliation
        await supabase
          .from('user_subscriptions')
          .update({
            stripe_period_end: new Date(invoice.period_end * 1000).toISOString()
          })
          .eq('user_id', subscription.user_id);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      // Handle cancellation
      const subscription = event.data.object;
      await supabase
        .from('user_subscriptions')
        .update({ status: 'cancelled' })
        .eq('external_subscription_id', subscription.id);
      break;
    }

    case 'checkout.session.completed': {
      // Handle one-time credit pack purchase
      const session = event.data.object;
      if (session.mode === 'payment') {
        const { user_id, pack_id } = session.metadata;
        const paymentIntentId = session.payment_intent;

        // IDEMPOTENCY: Check if this payment was already processed
        const { data: existingTopup } = await supabase
          .from('credit_topups')
          .select('id, status')
          .eq('external_payment_id', paymentIntentId)
          .single();

        if (existingTopup) {
          // Payment already processed, skip
          console.log(`Topup ${existingTopup.id} already processed (status: ${existingTopup.status})`);
          break;
        }

        // Process new topup
        const { data: pack } = await supabase
          .from('credit_packs')
          .select('credits_amount, price_usd')
          .eq('id', pack_id)
          .single();

        const { data: topup } = await supabase
          .from('credit_topups')
          .insert({
            user_id,
            credit_pack_id: pack_id,
            credits_purchased: pack.credits_amount,
            price_paid_usd: pack.price_usd,
            payment_provider: 'stripe',
            external_payment_id: paymentIntentId,
            status: 'pending'
          })
          .select()
          .single();

        // Grant credits
        await supabase.rpc('grant_topup_credits', {
          p_topup_id: topup.id
        });
      }
      break;
    }
  }

  res.json({ received: true });
};

module.exports = { handleStripeWebhook };
```

---

## Fallback Job (Cron)

### src/jobs/renewSubscriptions.job.js

```javascript
const { supabase } = require('../config/supabase');
const logger = require('../config/logger');

const renewOverdueSubscriptions = async () => {
  const now = new Date().toISOString();

  // Find subscriptions where period has ended
  const { data: overdueSubscriptions } = await supabase
    .from('user_subscriptions')
    .select('user_id')
    .eq('status', 'active')
    .lte('current_period_end', now);

  logger.info(`Found ${overdueSubscriptions?.length || 0} overdue subscriptions`);

  for (const sub of overdueSubscriptions || []) {
    try {
      await supabase.rpc('renew_subscription_cycle', {
        p_user_id: sub.user_id
      });
      logger.info(`Renewed subscription for user ${sub.user_id}`);
    } catch (error) {
      logger.error(`Renewal failed for user ${sub.user_id}:`, error);
    }
  }
};

// Run daily via node-cron or external scheduler
module.exports = renewOverdueSubscriptions;
```

---

## Deferred Features (Add When Needed)

### 1. Billing Drift Correction (Future Enhancement)

**When:** If you notice >5min drift or need exact Stripe alignment for accounting

**How:**
- You're already logging `stripe_period_end` in webhooks
- Refactor to pass actual dates to `create_subscription_cycle`:

```sql
-- Updated signature
CREATE FUNCTION create_subscription_cycle(
  p_user_id uuid,
  p_subscription_plan_id uuid,
  p_closing_cycle_id uuid,
  p_cycle_start_at timestamptz,
  p_cycle_end_at timestamptz
) ...

-- Update INSERT to use passed dates instead of NOW()
INSERT INTO subscription_cycles (..., cycle_start_at, cycle_end_at, ...)
VALUES (..., p_cycle_start_at, p_cycle_end_at, ...);
```

---

### 2. Feature Usage Analytics Table (Future Enhancement)

**When:** You want dashboards like "recording vs chat usage by cohort"

**How:**

```sql
-- Create table
CREATE TABLE feature_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  usage_type text,
  credits_consumed integer,
  reference_type text,
  reference_id uuid,
  created_at timestamptz DEFAULT NOW()
);

-- Backfill from ledger metadata
INSERT INTO feature_usage (user_id, usage_type, credits_consumed, reference_type, reference_id, created_at)
SELECT
  user_id,
  metadata->>'usage_type',
  -amount,  -- consumption entries are negative
  metadata->>'reference_type',
  (metadata->>'reference_id')::uuid,
  created_at
FROM credit_ledger
WHERE entry_type = 'consumption' AND metadata IS NOT NULL;

-- Going forward, modify deduct_credits to insert into both tables
```

---

### 3. Automated Reconciliation Job (Future Enhancement)

**When:** >500 users or after first suspected credit discrepancy

**How:**

```javascript
// src/jobs/reconcileCredits.job.js
const reconcileCredits = async () => {
  const { data: users } = await supabase.from('users').select('id');

  for (const user of users) {
    // Get materialized balance
    const { data: credits } = await supabase
      .from('user_credits')
      .select('plan_credits, topup_credits')
      .eq('user_id', user.id)
      .single();

    const dbBalance = credits.plan_credits + credits.topup_credits;

    // Get ledger balance
    const { data: ledgerSum } = await supabase
      .from('credit_ledger')
      .select('amount')
      .eq('user_id', user.id);

    const ledgerBalance = ledgerSum.reduce((sum, row) => sum + row.amount, 0);

    // Alert on drift
    if (dbBalance !== ledgerBalance) {
      logger.error(`Credit drift detected for user ${user.id}`, {
        dbBalance,
        ledgerBalance,
        diff: dbBalance - ledgerBalance
      });
    }
  }
};
```

---

## Implementation Estimate

- **Database migrations**: 2 days
- **Database functions & triggers**: 1 day
- **Backend services**: 2 days
- **Webhook integration**: 2 days
- **Testing**: 2 days

**Total: ~9 days** (vs 15+ for full v2.3 with all features)

---

## Why This Design Works

✅ **Production-ready** - Full audit trail, idempotent, handles edge cases
✅ **Legally defensible** - Every credit movement logged immutably
✅ **Customer support ready** - Can query any billing period's usage
✅ **Extensible** - Analytics can be backfilled from `ledger.metadata` when needed
✅ **Pragmatic** - Defers complexity until proven necessary
✅ **Fast to market** - 40% less implementation time than full v2.3

This is the sweet spot: robust enough for production, simple enough to ship quickly.
