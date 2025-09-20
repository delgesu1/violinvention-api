const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { supabase } = require('../config/supabase');
const { roleRights } = require('../config/roles');

/**
 * Verify Supabase JWT token and attach user to request
 * This middleware replaces the passport JWT strategy with Supabase authentication
 */
const verifySupabaseToken = async (token) => {
  try {
    // Verify the JWT token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid or expired token');
    }
    
    return user;
  } catch (error) {
    console.error('Token verification error:', error);
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
};

/**
 * Auth middleware for Supabase authentication
 * @param {...string} requiredRights - Required rights for the route
 */
const supabaseAuth = (...requiredRights) => async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'No authentication token provided');
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Verify token and get user from Supabase
    const supabaseUser = await verifySupabaseToken(token);
    
    // Get additional user data from our public.users table if needed
    // For now, we'll map Supabase user directly
    const user = {
      id: supabaseUser.id,
      email: supabaseUser.email,
      role: supabaseUser.user_metadata?.role || 'user',
      // Add any other fields needed for compatibility
      name: supabaseUser.user_metadata?.name || supabaseUser.email?.split('@')[0] || 'User',
    };
    
    // Attach user to request
    req.user = user;
    req.supabaseUser = supabaseUser; // Keep original Supabase user data
    
    // Check required rights if specified
    if (requiredRights.length) {
      const userRights = roleRights.get(user.role) || [];
      const hasRequiredRights = requiredRights.every((requiredRight) => userRights.includes(requiredRight));
      
      if (!hasRequiredRights && req.params.userId !== user.id) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Insufficient permissions');
      }
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional auth middleware - allows both authenticated and unauthenticated requests
 */
const optionalSupabaseAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const supabaseUser = await verifySupabaseToken(token);
      
      req.user = {
        id: supabaseUser.id,
        email: supabaseUser.email,
        role: supabaseUser.user_metadata?.role || 'user',
        name: supabaseUser.user_metadata?.name || supabaseUser.email?.split('@')[0] || 'User',
      };
      req.supabaseUser = supabaseUser;
    }
    next();
  } catch (error) {
    // If token verification fails in optional auth, continue without user
    next();
  }
};

module.exports = {
  supabaseAuth,
  optionalSupabaseAuth,
  verifySupabaseToken,
};