const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Simple HTML entity decoder
function decodeHTMLEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

// Global browser instance for efficiency
let browser = null;

// Browser is pre-installed in Playwright Docker image

// Initialize Playwright browser
async function initBrowser() {
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    console.log('Playwright browser initialized');
  } catch (error) {
    console.error('Failed to initialize browser:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down PDF service...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down PDF service...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

const { Semaphore } = require('./semaphore');
const semaphore = new Semaphore(3);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    browserReady: browser !== null,
    timestamp: new Date().toISOString()
  });
});

// PDF generation endpoint
app.post('/generate', async (req, res) => {
  const startTime = Date.now();

  try {
    const { html, title = 'document' } = req.body;

    if (!html) {
      return res.status(400).json({
        error: 'HTML content is required',
        code: 'MISSING_HTML'
      });
    }

    // Debug logging to see what HTML we're receiving
    console.log('Received HTML content length:', html.length);
    console.log('HTML content starts with:', html.substring(0, 200));
    console.log('HTML content type:', typeof html);

    // Decode HTML entities if present
    const decodedHTML = decodeHTMLEntities(html);
    console.log('Decoded HTML starts with:', decodedHTML.substring(0, 100));

    if (!browser) {
      return res.status(503).json({
        error: 'PDF service not ready',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Acquire semaphore slot
    await semaphore.acquire();

    try {
      // Create new page for this request
      const page = await browser.newPage();

      try {
        // Set content with proper viewport
        await page.setContent(decodedHTML, {
          waitUntil: 'networkidle0',
          timeout: 15000
        });

        // Set viewport for consistent rendering
        await page.setViewportSize({
          width: 1200,
          height: 800
        });

        // Generate PDF with optimized settings
        const pdfBuffer = await page.pdf({
          format: 'Letter',
          margin: {
            top: '0in',
            right: '0in',
            bottom: '0in',
            left: '0in'
          },
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false
        });

        const duration = Date.now() - startTime;
        console.log(`PDF generated in ${duration}ms, size: ${pdfBuffer.length} bytes`);

        // Set headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);

        // Send PDF buffer
        res.send(pdfBuffer);

      } finally {
        // Always close the page
        await page.close();
      }

    } finally {
      // Always release semaphore
      semaphore.release();
    }

  } catch (error) {
    console.error('PDF generation error:', error);

    const duration = Date.now() - startTime;
    console.log(`PDF generation failed after ${duration}ms`);

    // Return appropriate error response
    if (error.message.includes('timeout')) {
      return res.status(408).json({
        error: 'PDF generation timeout',
        code: 'TIMEOUT'
      });
    }

    res.status(500).json({
      error: 'PDF generation failed',
      code: 'GENERATION_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Start server and initialize browser
async function startServer() {
  await initBrowser();

  app.listen(PORT, () => {
    console.log(`PDF service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

startServer().catch(console.error);
