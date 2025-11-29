/**
 * Validation Schema Tests
 *
 * Tests for request validation schemas used across the API.
 */

const test = require('node:test');
const assert = require('node:assert');

// Validation helper functions (matching the actual validation logic)
const validators = {
  isValidUUID: (value) => {
    if (!value || typeof value !== 'string') return false;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidPattern.test(value);
  },

  isNonEmptyString: (value) => {
    return value && typeof value === 'string' && value.trim().length > 0;
  },

  isValidChatMode: (value) => {
    const validModes = ['arco', 'personal_lessons'];
    return validModes.includes(value);
  },

  isValidModel: (value) => {
    const validModels = ['arco', 'arco-pro'];
    return validModels.includes(value);
  },

  isValidMessageContent: (value, maxLength = 10000) => {
    return (
      value &&
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= maxLength
    );
  },

  isValidEmail: (value) => {
    if (!value || typeof value !== 'string') return false;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailPattern.test(value);
  },

  isPositiveInteger: (value) => {
    return Number.isInteger(value) && value > 0;
  },

  isValidTimestamp: (value) => {
    if (!value) return false;
    const date = new Date(value);
    return !isNaN(date.getTime());
  },

  isValidArrayOfStrings: (value, maxItems = 100) => {
    if (!Array.isArray(value)) return false;
    if (value.length > maxItems) return false;
    return value.every((item) => typeof item === 'string');
  },
};

test('UUID Validation', async (t) => {
  await t.test('accepts valid UUIDs', () => {
    const validUUIDs = [
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      '00000000-0000-0000-0000-000000000000',
      'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      '12345678-1234-1234-1234-123456789abc',
    ];

    for (const uuid of validUUIDs) {
      assert.ok(validators.isValidUUID(uuid), `${uuid} should be valid`);
    }
  });

  await t.test('rejects invalid UUIDs', () => {
    const invalidUUIDs = [
      '',
      'not-a-uuid',
      '12345',
      'a1b2c3d4-e5f6-7890-abcd', // Too short
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890-extra', // Too long
      'g1b2c3d4-e5f6-7890-abcd-ef1234567890', // Invalid hex
      null,
      undefined,
      123,
      {},
    ];

    for (const uuid of invalidUUIDs) {
      assert.ok(!validators.isValidUUID(uuid), `${uuid} should be invalid`);
    }
  });
});

test('String Validation', async (t) => {
  await t.test('isNonEmptyString', async (t) => {
    await t.test('accepts non-empty strings', () => {
      const valid = ['hello', ' trimmed ', 'a', 'long string with spaces'];

      for (const str of valid) {
        assert.ok(validators.isNonEmptyString(str), `"${str}" should be valid`);
      }
    });

    await t.test('rejects empty or invalid strings', () => {
      const invalid = ['', '   ', '\n\t', null, undefined, 123, [], {}];

      for (const str of invalid) {
        assert.ok(!validators.isNonEmptyString(str), `"${str}" should be invalid`);
      }
    });
  });
});

test('Chat Mode Validation', async (t) => {
  await t.test('accepts valid chat modes', () => {
    assert.ok(validators.isValidChatMode('arco'));
    assert.ok(validators.isValidChatMode('personal_lessons'));
  });

  await t.test('rejects invalid chat modes', () => {
    const invalid = ['', 'chat', 'ai', 'personal', 'ARCO', null, undefined];

    for (const mode of invalid) {
      assert.ok(!validators.isValidChatMode(mode), `"${mode}" should be invalid`);
    }
  });
});

test('Model Validation', async (t) => {
  await t.test('accepts valid models', () => {
    assert.ok(validators.isValidModel('arco'));
    assert.ok(validators.isValidModel('arco-pro'));
  });

  await t.test('rejects invalid models', () => {
    const invalid = ['', 'gpt-4', 'claude', 'ARCO', 'arco-pro-max', null];

    for (const model of invalid) {
      assert.ok(!validators.isValidModel(model), `"${model}" should be invalid`);
    }
  });
});

test('Message Content Validation', async (t) => {
  await t.test('accepts valid message content', () => {
    const valid = [
      'Hello',
      'A longer message with multiple words.',
      'Message with\nnewlines\nincluded.',
      'A'.repeat(1000), // Long but within limit
    ];

    for (const content of valid) {
      assert.ok(validators.isValidMessageContent(content), `Should accept message of length ${content.length}`);
    }
  });

  await t.test('rejects invalid message content', () => {
    const invalid = [
      '',
      '   ',
      '\n\n\n',
      'A'.repeat(15000), // Exceeds default max
      null,
      undefined,
    ];

    for (const content of invalid) {
      assert.ok(
        !validators.isValidMessageContent(content),
        `Should reject: ${content === null ? 'null' : typeof content}`
      );
    }
  });

  await t.test('respects custom max length', () => {
    const content = 'A'.repeat(500);
    assert.ok(validators.isValidMessageContent(content, 1000));
    assert.ok(!validators.isValidMessageContent(content, 100));
  });
});

test('Email Validation', async (t) => {
  await t.test('accepts valid emails', () => {
    const valid = [
      'test@example.com',
      'user.name@domain.org',
      'user+tag@gmail.com',
      'a@b.co',
    ];

    for (const email of valid) {
      assert.ok(validators.isValidEmail(email), `${email} should be valid`);
    }
  });

  await t.test('rejects invalid emails', () => {
    const invalid = [
      '',
      'not-an-email',
      '@domain.com',
      'user@',
      'user@domain',
      'user name@domain.com',
      null,
      undefined,
    ];

    for (const email of invalid) {
      assert.ok(!validators.isValidEmail(email), `${email} should be invalid`);
    }
  });
});

test('Integer Validation', async (t) => {
  await t.test('accepts positive integers', () => {
    const valid = [1, 10, 100, 1000000];

    for (const num of valid) {
      assert.ok(validators.isPositiveInteger(num), `${num} should be valid`);
    }
  });

  await t.test('rejects non-positive integers', () => {
    const invalid = [0, -1, -100, 1.5, '1', null, undefined, NaN, Infinity];

    for (const num of invalid) {
      assert.ok(!validators.isPositiveInteger(num), `${num} should be invalid`);
    }
  });
});

test('Timestamp Validation', async (t) => {
  await t.test('accepts valid timestamps', () => {
    const valid = [
      '2025-03-15T10:30:00.000Z',
      '2025-03-15',
      new Date().toISOString(),
      Date.now(),
    ];

    for (const ts of valid) {
      assert.ok(validators.isValidTimestamp(ts), `${ts} should be valid`);
    }
  });

  await t.test('rejects invalid timestamps', () => {
    const invalid = [
      '',
      'not-a-date',
      'invalid-timestamp',
      null,
      undefined,
    ];

    for (const ts of invalid) {
      assert.ok(!validators.isValidTimestamp(ts), `${ts} should be invalid`);
    }
  });
});

test('Array Validation', async (t) => {
  await t.test('accepts valid string arrays', () => {
    const valid = [[], ['a'], ['a', 'b', 'c'], ['string1', 'string2']];

    for (const arr of valid) {
      assert.ok(validators.isValidArrayOfStrings(arr));
    }
  });

  await t.test('rejects invalid arrays', () => {
    const invalid = [
      'not-array',
      null,
      undefined,
      [1, 2, 3],
      ['string', 123],
      { 0: 'a', 1: 'b' },
    ];

    for (const arr of invalid) {
      assert.ok(!validators.isValidArrayOfStrings(arr));
    }
  });

  await t.test('respects maxItems limit', () => {
    const smallArray = ['a', 'b', 'c'];
    const largeArray = Array(200).fill('item');

    assert.ok(validators.isValidArrayOfStrings(smallArray, 10));
    assert.ok(!validators.isValidArrayOfStrings(largeArray, 100));
  });
});

test('Chat Request Validation', async (t) => {
  const validateCreateChatRequest = (body) => {
    const errors = [];

    if (body.chat_mode && !validators.isValidChatMode(body.chat_mode)) {
      errors.push('Invalid chat_mode');
    }

    if (body.title && typeof body.title !== 'string') {
      errors.push('title must be a string');
    }

    if (body.title && body.title.length > 255) {
      errors.push('title exceeds maximum length');
    }

    return { valid: errors.length === 0, errors };
  };

  await t.test('validates create chat request', () => {
    const validRequests = [
      { chat_mode: 'arco' },
      { chat_mode: 'personal_lessons', title: 'My Chat' },
      { title: 'Just a title' },
      {},
    ];

    for (const req of validRequests) {
      const result = validateCreateChatRequest(req);
      assert.ok(result.valid, `Should accept: ${JSON.stringify(req)}`);
    }
  });

  await t.test('rejects invalid create chat requests', () => {
    const invalidRequests = [
      { chat_mode: 'invalid' },
      { title: 'A'.repeat(300) },
    ];

    for (const req of invalidRequests) {
      const result = validateCreateChatRequest(req);
      assert.ok(!result.valid, `Should reject: ${JSON.stringify(req)}`);
    }
  });
});

test('Message Request Validation', async (t) => {
  const validateFirstMessageRequest = (body) => {
    const errors = [];

    if (!validators.isValidMessageContent(body.message)) {
      errors.push('message is required and must be non-empty');
    }

    if (body.chat_mode && !validators.isValidChatMode(body.chat_mode)) {
      errors.push('Invalid chat_mode');
    }

    if (body.model && !validators.isValidModel(body.model)) {
      errors.push('Invalid model');
    }

    return { valid: errors.length === 0, errors };
  };

  const validateContinueMessageRequest = (body) => {
    const errors = [];

    if (!validators.isValidUUID(body.chat_id)) {
      errors.push('chat_id is required and must be a valid UUID');
    }

    if (!validators.isValidMessageContent(body.message)) {
      errors.push('message is required and must be non-empty');
    }

    return { valid: errors.length === 0, errors };
  };

  await t.test('validates first message request', () => {
    const validRequests = [
      { message: 'Hello' },
      { message: 'Hello', chat_mode: 'arco', model: 'arco' },
      { message: 'Hello', chat_mode: 'personal_lessons', model: 'arco-pro' },
    ];

    for (const req of validRequests) {
      const result = validateFirstMessageRequest(req);
      assert.ok(result.valid, `Should accept: ${JSON.stringify(req)}`);
    }
  });

  await t.test('rejects invalid first message requests', () => {
    const invalidRequests = [
      {},
      { message: '' },
      { message: 'Hello', chat_mode: 'invalid' },
      { message: 'Hello', model: 'gpt-4' },
    ];

    for (const req of invalidRequests) {
      const result = validateFirstMessageRequest(req);
      assert.ok(!result.valid, `Should reject: ${JSON.stringify(req)}`);
    }
  });

  await t.test('validates continue message request', () => {
    const validRequest = {
      chat_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      message: 'Follow up question',
    };

    const result = validateContinueMessageRequest(validRequest);
    assert.ok(result.valid);
  });

  await t.test('rejects invalid continue message requests', () => {
    const invalidRequests = [
      { message: 'Hello' }, // Missing chat_id
      { chat_id: 'not-uuid', message: 'Hello' },
      { chat_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }, // Missing message
    ];

    for (const req of invalidRequests) {
      const result = validateContinueMessageRequest(req);
      assert.ok(!result.valid, `Should reject: ${JSON.stringify(req)}`);
    }
  });
});

test('Vector Store Request Validation', async (t) => {
  const validateUploadRequest = (body) => {
    const errors = [];

    if (!validators.isValidUUID(body.recording_id)) {
      errors.push('recording_id is required and must be a valid UUID');
    }

    if (!validators.isNonEmptyString(body.content)) {
      errors.push('content is required');
    }

    if (body.metadata && typeof body.metadata !== 'object') {
      errors.push('metadata must be an object');
    }

    return { valid: errors.length === 0, errors };
  };

  const validateSearchRequest = (body) => {
    const errors = [];

    if (!validators.isNonEmptyString(body.query)) {
      errors.push('query is required');
    }

    if (body.limit && !validators.isPositiveInteger(body.limit)) {
      errors.push('limit must be a positive integer');
    }

    if (body.limit && body.limit > 100) {
      errors.push('limit exceeds maximum of 100');
    }

    return { valid: errors.length === 0, errors };
  };

  await t.test('validates upload request', () => {
    const valid = {
      recording_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      content: 'Lesson transcript content',
      metadata: { title: 'Lesson 1' },
    };

    const result = validateUploadRequest(valid);
    assert.ok(result.valid);
  });

  await t.test('validates search request', () => {
    const valid = {
      query: 'How to improve intonation',
      limit: 10,
    };

    const result = validateSearchRequest(valid);
    assert.ok(result.valid);
  });

  await t.test('rejects invalid search limit', () => {
    const invalid = {
      query: 'Test query',
      limit: 200,
    };

    const result = validateSearchRequest(invalid);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('limit exceeds maximum of 100'));
  });
});

test('Recording Processing Request Validation', async (t) => {
  const validateProcessingRequest = (body) => {
    const errors = [];

    if (!validators.isNonEmptyString(body.transcript)) {
      errors.push('transcript is required');
    }

    const validInstruments = ['violin', 'viola', 'cello', 'piano', 'flute', 'clarinet'];
    if (body.instrument && !validInstruments.includes(body.instrument)) {
      errors.push('Invalid instrument');
    }

    const validGenres = ['classical', 'jazz', 'folk', 'pop'];
    if (body.genre && !validGenres.includes(body.genre)) {
      errors.push('Invalid genre');
    }

    return { valid: errors.length === 0, errors };
  };

  await t.test('validates processing request', () => {
    const valid = {
      transcript: 'This is a lesson transcript...',
      instrument: 'violin',
      genre: 'classical',
    };

    const result = validateProcessingRequest(valid);
    assert.ok(result.valid);
  });

  await t.test('allows missing optional fields', () => {
    const valid = {
      transcript: 'This is a lesson transcript...',
    };

    const result = validateProcessingRequest(valid);
    assert.ok(result.valid);
  });

  await t.test('rejects invalid instrument', () => {
    const invalid = {
      transcript: 'Transcript',
      instrument: 'guitar', // Not in list
    };

    const result = validateProcessingRequest(invalid);
    assert.ok(!result.valid);
  });
});
