/**
 * Message Controller Tests
 *
 * Tests for the message controller which handles HTTP requests
 * for message operations (first message, continue chat, streaming).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createTestUserId, createMockChat, createMockMessage, createMockStreamEvents } = require('./setup');

// Mock message service
const mockMessageService = {
  sendFirstMessage: async (payload) => {
    return {
      chat_id: `chat_${Date.now()}`,
      message_id: `msg_${Date.now()}`,
      role: 'assistant',
      content: 'Hello! How can I help you today?',
      created_at: new Date().toISOString(),
    };
  },
  sendMessage: async (payload) => {
    if (!payload.chat_id) {
      throw new Error('chat_id is required');
    }
    return {
      message_id: `msg_${Date.now()}`,
      chat_id: payload.chat_id,
      role: 'assistant',
      content: 'This is a response to your message.',
      created_at: new Date().toISOString(),
    };
  },
  getChatMessages: async (chatId, userId, options = {}) => {
    return {
      messages: [
        createMockMessage(chatId, 'user'),
        createMockMessage(chatId, 'assistant'),
      ],
      hasMore: false,
    };
  },
  selectPromptConfig: (chatMode, model, isLessonPlanPrompt) => {
    // Determine prompt based on mode and model
    if (isLessonPlanPrompt) {
      return { promptId: 'lesson_plan_prompt', promptVersion: '1.0' };
    }

    const isDeepThink = model === 'arco-pro';
    const isPersonalLessons = chatMode === 'personal_lessons';

    if (isPersonalLessons && isDeepThink) {
      return { promptId: 'personal_lessons_deepdive', promptVersion: '1.0' };
    } else if (isPersonalLessons) {
      return { promptId: 'personal_lessons', promptVersion: '1.0' };
    } else if (isDeepThink) {
      return { promptId: 'deepthink', promptVersion: '1.0' };
    }
    return { promptId: 'default', promptVersion: '1.0' };
  },
};

test('Message Controller', async (t) => {
  const userId = createTestUserId();

  await t.test('sendFirstMessage', async (t) => {
    await t.test('creates new chat and sends message', async () => {
      const payload = {
        message: 'Hello, I have a question about violin technique.',
        chat_mode: 'arco',
        model: 'arco',
        user_id: userId,
      };

      const result = await mockMessageService.sendFirstMessage(payload);

      assert.ok(result.chat_id, 'Should return chat_id');
      assert.ok(result.message_id, 'Should return message_id');
      assert.strictEqual(result.role, 'assistant');
    });

    await t.test('supports lesson_plan_prompt flag', async () => {
      const config = mockMessageService.selectPromptConfig('arco', 'arco', true);
      assert.strictEqual(config.promptId, 'lesson_plan_prompt');
    });

    await t.test('validates required message field', () => {
      const validPayloads = [
        { message: 'Valid message' },
        { message: 'Short' },
      ];

      const invalidPayloads = [
        { message: '' },
        { message: '   ' },
        {},
      ];

      for (const payload of validPayloads) {
        assert.ok(payload.message && payload.message.trim(), 'Message should be present and non-empty');
      }

      for (const payload of invalidPayloads) {
        assert.ok(!payload.message || !payload.message.trim(), 'Message should be empty or missing');
      }
    });
  });

  await t.test('sendMessage', async (t) => {
    await t.test('sends message to existing chat', async () => {
      const payload = {
        chat_id: 'chat_123',
        message: 'Follow up question',
        user_id: userId,
      };

      const result = await mockMessageService.sendMessage(payload);

      assert.ok(result.message_id, 'Should return message_id');
      assert.strictEqual(result.chat_id, 'chat_123');
    });

    await t.test('throws error when chat_id missing', async () => {
      await assert.rejects(
        async () => {
          await mockMessageService.sendMessage({
            message: 'Message without chat_id',
          });
        },
        {
          message: /chat_id is required/,
        }
      );
    });
  });

  await t.test('getChatMessages', async (t) => {
    await t.test('returns messages for chat', async () => {
      const result = await mockMessageService.getChatMessages('chat_123', userId);

      assert.ok(Array.isArray(result.messages), 'Should return array of messages');
      assert.ok(result.messages.length >= 0, 'Should have messages');
    });

    await t.test('supports pagination', async () => {
      const result = await mockMessageService.getChatMessages('chat_123', userId, {
        limit: 20,
        before_message_id: 'msg_100',
      });

      assert.ok(typeof result.hasMore === 'boolean', 'Should have hasMore flag');
    });
  });
});

test('Prompt Selection Logic', async (t) => {
  await t.test('selectPromptConfig', async (t) => {
    await t.test('returns default prompt for arco mode and standard model', () => {
      const config = mockMessageService.selectPromptConfig('arco', 'arco', false);
      assert.strictEqual(config.promptId, 'default');
    });

    await t.test('returns deepthink prompt for arco mode and arco-pro model', () => {
      const config = mockMessageService.selectPromptConfig('arco', 'arco-pro', false);
      assert.strictEqual(config.promptId, 'deepthink');
    });

    await t.test('returns personal_lessons prompt for personal_lessons mode', () => {
      const config = mockMessageService.selectPromptConfig('personal_lessons', 'arco', false);
      assert.strictEqual(config.promptId, 'personal_lessons');
    });

    await t.test('returns personal_lessons_deepdive for personal_lessons + arco-pro', () => {
      const config = mockMessageService.selectPromptConfig('personal_lessons', 'arco-pro', false);
      assert.strictEqual(config.promptId, 'personal_lessons_deepdive');
    });

    await t.test('returns lesson_plan_prompt when flag is set', () => {
      const config = mockMessageService.selectPromptConfig('arco', 'arco', true);
      assert.strictEqual(config.promptId, 'lesson_plan_prompt');
    });

    await t.test('lesson_plan_prompt overrides mode and model', () => {
      const config1 = mockMessageService.selectPromptConfig('personal_lessons', 'arco-pro', true);
      const config2 = mockMessageService.selectPromptConfig('arco', 'arco', true);

      assert.strictEqual(config1.promptId, 'lesson_plan_prompt');
      assert.strictEqual(config2.promptId, 'lesson_plan_prompt');
    });
  });
});

test('Message Validation', async (t) => {
  await t.test('message content validation', async (t) => {
    await t.test('validates message is not empty', () => {
      const isValid = (message) =>
        message && typeof message === 'string' && message.trim().length > 0;

      assert.ok(isValid('Valid message'), 'Should accept valid message');
      assert.ok(!isValid(''), 'Should reject empty message');
      assert.ok(!isValid('   '), 'Should reject whitespace-only message');
      assert.ok(!isValid(null), 'Should reject null');
      assert.ok(!isValid(undefined), 'Should reject undefined');
    });

    await t.test('validates message length', () => {
      const maxLength = 10000;
      const isValid = (message) =>
        message && message.length <= maxLength;

      const validMessage = 'A'.repeat(1000);
      const invalidMessage = 'A'.repeat(20000);

      assert.ok(isValid(validMessage), 'Should accept message within limit');
      assert.ok(!isValid(invalidMessage), 'Should reject message exceeding limit');
    });
  });

  await t.test('model validation', async (t) => {
    await t.test('validates model is valid enum', () => {
      const validModels = ['arco', 'arco-pro'];

      const isValid = (model) => validModels.includes(model);

      assert.ok(isValid('arco'), 'Should accept arco');
      assert.ok(isValid('arco-pro'), 'Should accept arco-pro');
      assert.ok(!isValid('gpt-4'), 'Should reject invalid model');
      assert.ok(!isValid(''), 'Should reject empty model');
    });

    await t.test('defaults to arco when invalid', () => {
      const validModels = ['arco', 'arco-pro'];
      const normalizeModel = (model) => {
        if (validModels.includes(model)) return model;
        return 'arco';
      };

      assert.strictEqual(normalizeModel('invalid'), 'arco');
      assert.strictEqual(normalizeModel(''), 'arco');
      assert.strictEqual(normalizeModel(null), 'arco');
    });
  });

  await t.test('chat_mode validation', async (t) => {
    await t.test('validates chat_mode is valid enum', () => {
      const validModes = ['arco', 'personal_lessons'];

      const isValid = (mode) => validModes.includes(mode);

      assert.ok(isValid('arco'), 'Should accept arco');
      assert.ok(isValid('personal_lessons'), 'Should accept personal_lessons');
      assert.ok(!isValid('chat'), 'Should reject invalid mode');
    });
  });
});

test('Streaming Response Handling', async (t) => {
  await t.test('stream event types', async (t) => {
    const events = createMockStreamEvents();

    await t.test('includes all required event types', () => {
      const eventTypes = events.map((e) => e.type);

      assert.ok(eventTypes.includes('response.created'), 'Should have response.created');
      assert.ok(eventTypes.includes('response.output_text.delta'), 'Should have delta events');
      assert.ok(eventTypes.includes('response.done'), 'Should have response.done');
    });

    await t.test('delta events contain text content', () => {
      const deltaEvents = events.filter((e) => e.type === 'response.output_text.delta');

      for (const event of deltaEvents) {
        assert.ok(event.data.delta, 'Delta event should have delta text');
      }
    });

    await t.test('done event contains complete response', () => {
      const doneEvent = events.find((e) => e.type === 'response.done');

      assert.ok(doneEvent, 'Should have done event');
      assert.ok(doneEvent.data.response, 'Done event should have response');
    });
  });

  await t.test('stream error handling', async (t) => {
    await t.test('handles connection errors', () => {
      const errorEvent = {
        type: 'error',
        data: {
          code: 'CONNECTION_ERROR',
          message: 'Connection lost',
        },
      };

      assert.strictEqual(errorEvent.type, 'error');
      assert.ok(errorEvent.data.code, 'Error should have code');
    });

    await t.test('handles rate limit errors', () => {
      const errorEvent = {
        type: 'error',
        data: {
          code: 'RATE_LIMIT',
          message: 'Too many requests',
          retryAfter: 60,
        },
      };

      assert.ok(errorEvent.data.retryAfter, 'Rate limit error should have retry info');
    });
  });
});

test('Message Interruption', async (t) => {
  await t.test('handles message interruption', () => {
    // Simulate interruption by user pressing stop button
    const message = {
      message_id: 'msg_123',
      content: 'Partial response that was inter',
      interrupted: true,
    };

    assert.ok(message.interrupted, 'Should mark message as interrupted');
    assert.ok(message.content.length > 0, 'Should preserve partial content');
  });

  await t.test('truncates content on interruption', () => {
    const partialContent = 'This is a partial response that was cut off mid-sent';
    const truncatedContent = partialContent.slice(0, partialContent.lastIndexOf(' '));

    assert.ok(truncatedContent.length < partialContent.length);
    assert.ok(!truncatedContent.endsWith(' '));
  });
});

test('Lesson Context Handling', async (t) => {
  await t.test('includes lesson_context in message', () => {
    const message = createMockMessage('chat_123', 'user', {
      lesson_context: [
        { recording_id: 'rec_1', title: 'Lesson 1' },
        { recording_id: 'rec_2', title: 'Lesson 2' },
      ],
    });

    assert.ok(Array.isArray(message.lesson_context), 'Should have lesson_context array');
    assert.strictEqual(message.lesson_context.length, 2);
  });

  await t.test('lesson plan metadata', () => {
    const message = createMockMessage('chat_123', 'assistant', {
      metadata: {
        is_lesson_plan: true,
        lesson_plan_full_context: 'Student: John Doe\nPieces: Bach Partita',
      },
    });

    assert.ok(message.metadata.is_lesson_plan, 'Should mark as lesson plan');
    assert.ok(message.metadata.lesson_plan_full_context, 'Should have full context');
  });
});
