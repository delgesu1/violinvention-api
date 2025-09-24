const express = require('express');
const httpStatus = require('http-status');

const router = express.Router();

// Internal PDF service URL (for DigitalOcean App Platform internal networking)
const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || 'http://localhost:3001';

/**
 * @route   POST /api/v1/pdf/generate
 * @desc    Generate PDF from HTML content
 * @access  Private (requires authentication)
 * @body    {html: string, title?: string}
 */
router.post('/generate', async (req, res) => {
  try {
    const { html, title } = req.body;

    // Validate input
    if (!html || typeof html !== 'string') {
      return res.status(httpStatus.BAD_REQUEST).json({
        error: 'HTML content is required and must be a string'
      });
    }

    // Forward request to PDF service
    const response = await fetch(`${PDF_SERVICE_URL}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ html, title }),
      signal: AbortSignal.timeout(25000) // 25s timeout (PDF service has 20s + buffer)
    });

    if (!response.ok) {
      // Handle PDF service errors
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: 'PDF service error', code: 'SERVICE_ERROR' };
      }

      const statusCode = response.status === 503 ? httpStatus.SERVICE_UNAVAILABLE :
                        response.status === 408 ? httpStatus.REQUEST_TIMEOUT :
                        response.status === 400 ? httpStatus.BAD_REQUEST :
                        httpStatus.INTERNAL_SERVER_ERROR;

      return res.status(statusCode).json(errorData);
    }

    // Stream PDF response back to client
    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');
    const contentLength = response.headers.get('content-length');

    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Set caching headers for PDFs (cache for 1 hour)
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Pipe PDF buffer to response
    const pdfBuffer = await response.arrayBuffer();
    res.send(Buffer.from(pdfBuffer));

  } catch (error) {
    console.error('PDF proxy error:', error);

    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      return res.status(httpStatus.REQUEST_TIMEOUT).json({
        error: 'PDF generation timeout',
        code: 'TIMEOUT'
      });
    }

    if (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
      return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
        error: 'PDF service unavailable',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'PDF generation failed',
      code: 'PROXY_ERROR'
    });
  }
});

/**
 * @route   GET /api/v1/pdf/health
 * @desc    Check PDF service health
 * @access  Public (for monitoring)
 */
router.get('/health', async (req, res) => {
  try {
    const response = await fetch(`${PDF_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
        status: 'unhealthy',
        pdfService: 'down',
        error: `HTTP ${response.status}`
      });
    }

    const healthData = await response.json();

    res.json({
      status: 'healthy',
      pdfService: healthData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('PDF health check error:', error);

    res.status(httpStatus.SERVICE_UNAVAILABLE).json({
      status: 'unhealthy',
      pdfService: 'unreachable',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;