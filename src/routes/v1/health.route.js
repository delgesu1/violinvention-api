const express = require('express');

const router = express.Router();

/**
 * GET /v1/health
 * Simple health check endpoint for production deployments
 * Returns basic service status information
 */
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'violinvention-api',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'unknown'
  });
});

module.exports = router;