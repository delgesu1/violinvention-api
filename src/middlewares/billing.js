/**
 * Billing Middleware
 * Credit and chat limit enforcement
 */

const httpStatus = require('http-status');
const billingService = require('../services/billing.service');
const ApiError = require('../utils/ApiError');

/**
 * Require credits for an action (lessons, deep dives)
 * @param {number} amount - Number of credits required (default: 1)
 */
const requireCredits = (amount = 1) => async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized');
    }

    const { allowed, state } = await billingService.checkAccess(userId, 'credit');

    if (!allowed) {
      return res.status(httpStatus.PAYMENT_REQUIRED).json({
        error: 'No credits remaining',
        code: 'INSUFFICIENT_CREDITS',
        upgrade_required: true,
      });
    }

    // Store for downstream handlers
    res.locals.billingState = state;
    res.locals.creditAmount = amount;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Check chat limit before processing a message
 */
const checkChatLimit = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized');
    }

    const { allowed, state, warning } = await billingService.checkAccess(userId, 'chat');

    if (!allowed) {
      return res.status(httpStatus.TOO_MANY_REQUESTS).json({
        error: 'Chat limit reached',
        code: 'CHAT_LIMIT_EXCEEDED',
        upgrade_required: true,
      });
    }

    // Store for downstream handlers
    res.locals.billingState = state;
    if (warning) {
      res.locals.chatWarning = warning;
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Consume a credit after successful action
 * Call this AFTER the action succeeds
 */
const consumeCredit = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next();
    }

    const amount = res.locals.creditAmount || 1;
    await billingService.consumeCredit(userId);
    next();
  } catch (error) {
    // Log but don't fail the request - the action already succeeded
    console.error('Failed to consume credit:', error);
    next();
  }
};

/**
 * Increment chat count after successful message
 * Call this AFTER the message is sent
 */
const incrementChatCount = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next();
    }

    await billingService.incrementChat(userId);
    next();
  } catch (error) {
    // Log but don't fail - the message already sent
    console.error('Failed to increment chat count:', error);
    next();
  }
};

module.exports = {
  requireCredits,
  checkChatLimit,
  consumeCredit,
  incrementChatCount,
};
