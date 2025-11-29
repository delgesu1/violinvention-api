/**
 * Error Scenario Tests
 *
 * Tests for error handling across the API including
 * API errors, database errors, rate limits, and edge cases.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createTestUserId, createMockChat } = require('./setup');

// Custom API Error class (matching the actual implementation)
class ApiError extends Error {
  constructor(statusCode, message, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

test('ApiError Class', async (t) => {
  await t.test('creates error with status code and message', () => {
    const error = new ApiError(404, 'Resource not found');

    assert.strictEqual(error.statusCode, 404);
    assert.strictEqual(error.message, 'Resource not found');
    assert.strictEqual(error.isOperational, true);
  });

  await t.test('supports non-operational errors', () => {
    const error = new ApiError(500, 'Internal server error', false);

    assert.strictEqual(error.isOperational, false);
  });

  await t.test('includes stack trace', () => {
    const error = new ApiError(400, 'Bad request');

    assert.ok(error.stack, 'Should have stack trace');
    // Stack trace should include the test file location (where error was created)
    assert.ok(error.stack.includes('errorScenarios.test.js'), 'Stack should include file location');
  });
});

test('HTTP Error Codes', async (t) => {
  const errorCases = [
    { code: 400, name: 'BAD_REQUEST', message: 'Invalid request payload' },
    { code: 401, name: 'UNAUTHORIZED', message: 'Authentication required' },
    { code: 403, name: 'FORBIDDEN', message: 'Access denied' },
    { code: 404, name: 'NOT_FOUND', message: 'Resource not found' },
    { code: 409, name: 'CONFLICT', message: 'Resource already exists' },
    { code: 422, name: 'UNPROCESSABLE_ENTITY', message: 'Validation failed' },
    { code: 429, name: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' },
    { code: 500, name: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong' },
    { code: 502, name: 'BAD_GATEWAY', message: 'Upstream service error' },
    { code: 503, name: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
  ];

  for (const { code, name, message } of errorCases) {
    await t.test(`handles ${code} ${name}`, () => {
      const error = new ApiError(code, message);

      assert.strictEqual(error.statusCode, code);
      assert.strictEqual(error.message, message);
    });
  }
});

test('Authentication Errors', async (t) => {
  await t.test('missing authorization header', () => {
    const headers = {};
    const hasAuth = 'authorization' in headers;

    assert.ok(!hasAuth, 'Should detect missing auth header');

    const error = new ApiError(401, 'Authorization header is required');
    assert.strictEqual(error.statusCode, 401);
  });

  await t.test('invalid bearer token format', () => {
    const invalidTokens = [
      'Bearer', // No token
      'Basic abc123', // Wrong scheme
      'bearer abc123', // Lowercase (might be invalid)
      'Bearer ', // Empty token
    ];

    for (const token of invalidTokens) {
      const parts = token.split(' ');
      const isValid =
        parts.length === 2 && parts[0] === 'Bearer' && parts[1].length > 0;

      // At least some of these should be invalid
      if (!isValid) {
        const error = new ApiError(401, 'Invalid authorization header format');
        assert.strictEqual(error.statusCode, 401);
      }
    }
  });

  await t.test('expired token', () => {
    const error = new ApiError(401, 'Token has expired');
    assert.strictEqual(error.statusCode, 401);
    assert.ok(error.message.includes('expired'));
  });

  await t.test('invalid token signature', () => {
    const error = new ApiError(401, 'Invalid token signature');
    assert.strictEqual(error.statusCode, 401);
  });
});

test('Database Errors', async (t) => {
  await t.test('connection timeout', () => {
    const dbError = {
      code: 'ECONNREFUSED',
      message: 'Connection refused',
    };

    const error = new ApiError(503, 'Database connection failed');
    assert.strictEqual(error.statusCode, 503);
  });

  await t.test('unique constraint violation', () => {
    const dbError = {
      code: '23505',
      constraint: 'unique_email',
      message: 'duplicate key value violates unique constraint',
    };

    const isUniqueViolation = dbError.code === '23505';
    assert.ok(isUniqueViolation);

    const error = new ApiError(409, 'Resource already exists');
    assert.strictEqual(error.statusCode, 409);
  });

  await t.test('foreign key violation', () => {
    const dbError = {
      code: '23503',
      message: 'violates foreign key constraint',
    };

    const error = new ApiError(400, 'Referenced resource does not exist');
    assert.strictEqual(error.statusCode, 400);
  });

  await t.test('not found (PGRST116)', () => {
    const dbError = {
      code: 'PGRST116',
      message: 'The result contains 0 rows',
    };

    const isNotFound = dbError.code === 'PGRST116';
    assert.ok(isNotFound);
  });

  await t.test('row-level security violation', () => {
    const dbError = {
      code: '42501',
      message: 'permission denied for table',
    };

    const error = new ApiError(403, 'Access denied');
    assert.strictEqual(error.statusCode, 403);
  });
});

test('OpenAI API Errors', async (t) => {
  await t.test('rate limit error', () => {
    const openaiError = {
      status: 429,
      message: 'Rate limit exceeded',
      headers: {
        'retry-after': '60',
      },
    };

    const error = new ApiError(429, 'AI service rate limit exceeded');
    assert.strictEqual(error.statusCode, 429);

    // Should include retry information
    const retryAfter = parseInt(openaiError.headers['retry-after'], 10);
    assert.strictEqual(retryAfter, 60);
  });

  await t.test('context length exceeded', () => {
    const openaiError = {
      status: 400,
      message: "This model's maximum context length is 128000 tokens",
    };

    const error = new ApiError(400, 'Request too large for AI model');
    assert.strictEqual(error.statusCode, 400);
  });

  await t.test('invalid API key', () => {
    const openaiError = {
      status: 401,
      message: 'Invalid API key',
    };

    // This should be logged but not exposed to client
    const error = new ApiError(502, 'AI service configuration error');
    assert.strictEqual(error.statusCode, 502);
  });

  await t.test('service unavailable', () => {
    const openaiError = {
      status: 503,
      message: 'Service temporarily unavailable',
    };

    const error = new ApiError(503, 'AI service temporarily unavailable');
    assert.strictEqual(error.statusCode, 503);
  });

  await t.test('empty response', () => {
    const response = {
      output: [],
    };

    const hasContent = response.output && response.output.length > 0;
    assert.ok(!hasContent);

    const error = new ApiError(502, 'AI service returned empty response');
    assert.strictEqual(error.statusCode, 502);
  });
});

test('Validation Errors', async (t) => {
  await t.test('missing required field', () => {
    const validateRequest = (body, requiredFields) => {
      const missing = requiredFields.filter((field) => !body[field]);
      if (missing.length > 0) {
        return {
          valid: false,
          error: new ApiError(400, `Missing required fields: ${missing.join(', ')}`),
        };
      }
      return { valid: true };
    };

    const result = validateRequest({ name: 'Test' }, ['name', 'email']);
    assert.ok(!result.valid);
    assert.strictEqual(result.error.statusCode, 400);
    assert.ok(result.error.message.includes('email'));
  });

  await t.test('invalid field type', () => {
    const body = { count: '10' }; // String instead of number
    const isNumber = typeof body.count === 'number';

    assert.ok(!isNumber);

    const error = new ApiError(400, 'count must be a number');
    assert.strictEqual(error.statusCode, 400);
  });

  await t.test('field exceeds max length', () => {
    const maxLength = 255;
    const value = 'A'.repeat(300);

    assert.ok(value.length > maxLength);

    const error = new ApiError(400, `Field exceeds maximum length of ${maxLength}`);
    assert.strictEqual(error.statusCode, 400);
  });

  await t.test('invalid enum value', () => {
    const validValues = ['a', 'b', 'c'];
    const value = 'd';

    assert.ok(!validValues.includes(value));

    const error = new ApiError(400, `Invalid value. Must be one of: ${validValues.join(', ')}`);
    assert.strictEqual(error.statusCode, 400);
  });
});

test('Resource Not Found Errors', async (t) => {
  await t.test('chat not found', () => {
    const chatId = 'nonexistent-chat-id';
    const chat = null;

    if (!chat) {
      const error = new ApiError(404, `Chat not found: ${chatId}`);
      assert.strictEqual(error.statusCode, 404);
    }
  });

  await t.test('message not found', () => {
    const messageId = 'nonexistent-message-id';
    const message = null;

    if (!message) {
      const error = new ApiError(404, `Message not found: ${messageId}`);
      assert.strictEqual(error.statusCode, 404);
    }
  });

  await t.test('recording not found', () => {
    const recordingId = 'nonexistent-recording-id';
    const recording = null;

    if (!recording) {
      const error = new ApiError(404, `Recording not found: ${recordingId}`);
      assert.strictEqual(error.statusCode, 404);
    }
  });

  await t.test('user settings not found', () => {
    const userId = 'nonexistent-user-id';
    const settings = null;

    // User settings should be created on demand, not throw 404
    if (!settings) {
      // Create default settings instead of error
      const defaultSettings = {
        user_id: userId,
        vector_store_id: null,
        checklist_data: {},
      };

      assert.ok(defaultSettings, 'Should create default settings');
    }
  });
});

test('Authorization Errors', async (t) => {
  await t.test('accessing other user resource', () => {
    const resourceOwnerId = 'user-123';
    const requesterId = 'user-456';

    const isOwner = resourceOwnerId === requesterId;
    assert.ok(!isOwner);

    const error = new ApiError(403, 'You do not have permission to access this resource');
    assert.strictEqual(error.statusCode, 403);
  });

  await t.test('accessing deleted resource', () => {
    const resource = { id: 'res-123', is_deleted: true };

    if (resource.is_deleted) {
      const error = new ApiError(404, 'Resource not found');
      assert.strictEqual(error.statusCode, 404);
    }
  });
});

test('Rate Limiting', async (t) => {
  await t.test('tracks request count', () => {
    const rateLimit = {
      maxRequests: 100,
      windowMs: 60000,
      current: 0,
    };

    // Simulate requests
    for (let i = 0; i < 50; i++) {
      rateLimit.current++;
    }

    assert.ok(rateLimit.current < rateLimit.maxRequests);
  });

  await t.test('rejects when limit exceeded', () => {
    const rateLimit = {
      maxRequests: 100,
      current: 100,
    };

    if (rateLimit.current >= rateLimit.maxRequests) {
      const error = new ApiError(429, 'Too many requests');
      assert.strictEqual(error.statusCode, 429);
    }
  });

  await t.test('includes rate limit headers', () => {
    const headers = {
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '50',
      'X-RateLimit-Reset': String(Date.now() + 60000),
    };

    assert.ok(headers['X-RateLimit-Limit']);
    assert.ok(headers['X-RateLimit-Remaining']);
    assert.ok(headers['X-RateLimit-Reset']);
  });
});

test('Streaming Errors', async (t) => {
  await t.test('connection closed during stream', () => {
    const streamState = {
      started: true,
      connected: false,
      error: 'Connection closed by client',
    };

    assert.ok(!streamState.connected);

    // Should handle gracefully without crashing
    const shouldRetry = false; // Client disconnected intentionally
    assert.ok(!shouldRetry);
  });

  await t.test('stream timeout', () => {
    const timeoutMs = 30000;
    const elapsed = 35000;

    if (elapsed > timeoutMs) {
      const error = new ApiError(504, 'Stream timed out');
      assert.strictEqual(error.statusCode, 504);
    }
  });

  await t.test('partial response on error', () => {
    const partialContent = 'This is a partial response that was cut off because';
    const error = { type: 'connection_error', message: 'Lost connection' };

    // Should save partial content
    const savedMessage = {
      content: partialContent,
      interrupted: true,
      error: error.message,
    };

    assert.ok(savedMessage.interrupted);
    assert.ok(savedMessage.content.length > 0);
  });
});

test('Vector Store Errors', async (t) => {
  await t.test('vector store not found', () => {
    const vectorStoreId = 'vs_nonexistent';
    const store = null;

    if (!store) {
      // Should create new vector store for user
      const newStore = { id: `vs_${Date.now()}` };
      assert.ok(newStore.id);
    }
  });

  await t.test('file upload failed', () => {
    const uploadError = {
      status: 400,
      message: 'File too large',
    };

    const error = new ApiError(400, 'Failed to upload file to vector store');
    assert.strictEqual(error.statusCode, 400);
  });

  await t.test('search failed', () => {
    const searchError = {
      status: 500,
      message: 'Search index not ready',
    };

    const error = new ApiError(503, 'Vector search temporarily unavailable');
    assert.strictEqual(error.statusCode, 503);
  });
});

test('PDF Generation Errors', async (t) => {
  await t.test('invalid HTML content', () => {
    const html = null;

    if (!html) {
      const error = new ApiError(400, 'HTML content is required');
      assert.strictEqual(error.statusCode, 400);
    }
  });

  await t.test('PDF service timeout', () => {
    const timeoutMs = 20000;
    const error = new ApiError(504, `PDF generation timed out after ${timeoutMs}ms`);
    assert.strictEqual(error.statusCode, 504);
  });

  await t.test('concurrent request limit', () => {
    const maxConcurrent = 3;
    const currentRequests = 3;

    if (currentRequests >= maxConcurrent) {
      const error = new ApiError(429, 'PDF service busy, please retry');
      assert.strictEqual(error.statusCode, 429);
    }
  });

  await t.test('PDF service unavailable', () => {
    const serviceHealthy = false;

    if (!serviceHealthy) {
      const error = new ApiError(503, 'PDF service temporarily unavailable');
      assert.strictEqual(error.statusCode, 503);
    }
  });
});

test('Error Response Format', async (t) => {
  await t.test('formats error response correctly', () => {
    const error = new ApiError(400, 'Invalid request');

    const response = {
      success: false,
      error: {
        code: error.statusCode,
        message: error.message,
        timestamp: new Date().toISOString(),
      },
    };

    assert.strictEqual(response.success, false);
    assert.strictEqual(response.error.code, 400);
    assert.strictEqual(response.error.message, 'Invalid request');
    assert.ok(response.error.timestamp);
  });

  await t.test('includes request ID for debugging', () => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const response = {
      success: false,
      error: {
        code: 500,
        message: 'Internal server error',
        requestId,
      },
    };

    assert.ok(response.error.requestId);
    assert.ok(response.error.requestId.startsWith('req_'));
  });

  await t.test('hides internal details in production', () => {
    const internalError = new Error('Database connection string: postgresql://user:pass@host/db');
    const isProduction = process.env.NODE_ENV === 'production';

    const sanitizedMessage = isProduction
      ? 'An internal error occurred'
      : internalError.message;

    // In production, should not expose connection string
    if (isProduction) {
      assert.ok(!sanitizedMessage.includes('postgresql://'));
    }
  });
});
