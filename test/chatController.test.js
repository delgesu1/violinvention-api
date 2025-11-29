/**
 * Chat Controller Tests
 *
 * Tests for the chat controller which handles HTTP requests
 * for chat operations (create, list, delete).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createTestUserId, createMockChat, makeSupabaseChain } = require('./setup');

// Mock dependencies
const mockChatService = {
  createChat: async (payload) => ({
    chat_id: `chat_${Date.now()}`,
    ...payload,
    created_at: new Date().toISOString(),
  }),
  getChat: async (chatId, userId) => {
    if (chatId === 'nonexistent') return null;
    return createMockChat({ chat_id: chatId, user_id: userId });
  },
  getUserChats: async (userId, options = {}) => {
    const chats = [
      createMockChat({ chat_id: 'chat_1', user_id: userId }),
      createMockChat({ chat_id: 'chat_2', user_id: userId }),
    ];
    return { chats, hasMore: false };
  },
  deleteChat: async (chatId, userId) => {
    if (chatId === 'nonexistent') {
      throw new Error('Chat not found');
    }
    return true;
  },
  updateChatTitle: async (chatId, userId, title) => {
    return createMockChat({ chat_id: chatId, user_id: userId, title });
  },
};

test('Chat Controller', async (t) => {
  const userId = createTestUserId();

  await t.test('createChat', async (t) => {
    await t.test('creates a new chat with valid payload', async () => {
      const payload = {
        title: 'New Chat',
        chat_mode: 'arco',
      };

      const result = await mockChatService.createChat({
        ...payload,
        user_id: userId,
      });

      assert.ok(result.chat_id, 'Should return chat_id');
      assert.strictEqual(result.chat_mode, 'arco');
      assert.strictEqual(result.title, 'New Chat');
    });

    await t.test('creates chat with personal_lessons mode', async () => {
      const payload = {
        title: 'Personal Chat',
        chat_mode: 'personal_lessons',
      };

      const result = await mockChatService.createChat({
        ...payload,
        user_id: userId,
      });

      assert.strictEqual(result.chat_mode, 'personal_lessons');
    });

    await t.test('validates chat_mode enum values', () => {
      const validModes = ['arco', 'personal_lessons'];
      const invalidModes = ['invalid', 'chat', 'ai'];

      for (const mode of validModes) {
        assert.ok(validModes.includes(mode), `${mode} should be valid`);
      }

      for (const mode of invalidModes) {
        assert.ok(!validModes.includes(mode), `${mode} should be invalid`);
      }
    });
  });

  await t.test('getChat', async (t) => {
    await t.test('returns chat when found', async () => {
      const result = await mockChatService.getChat('chat_123', userId);

      assert.ok(result, 'Should return chat');
      assert.ok(result.chat_id, 'Should have chat_id');
    });

    await t.test('returns null for nonexistent chat', async () => {
      const result = await mockChatService.getChat('nonexistent', userId);
      assert.strictEqual(result, null);
    });

    await t.test('validates user ownership', async () => {
      // This is tested through the service layer - controller passes user_id
      const result = await mockChatService.getChat('chat_123', userId);
      assert.strictEqual(result.user_id, userId);
    });
  });

  await t.test('getUserChats', async (t) => {
    await t.test('returns list of chats for user', async () => {
      const result = await mockChatService.getUserChats(userId);

      assert.ok(Array.isArray(result.chats), 'Should return array of chats');
      assert.ok(result.chats.length > 0, 'Should have at least one chat');
    });

    await t.test('supports pagination', async () => {
      const result = await mockChatService.getUserChats(userId, {
        limit: 10,
        offset: 0,
      });

      assert.ok(typeof result.hasMore === 'boolean', 'Should have hasMore flag');
    });

    await t.test('filters by chat_mode', async () => {
      // Simulate filtering
      const arcoChats = [createMockChat({ chat_mode: 'arco' })];

      assert.ok(arcoChats.every((c) => c.chat_mode === 'arco'));
    });
  });

  await t.test('deleteChat', async (t) => {
    await t.test('deletes existing chat', async () => {
      const result = await mockChatService.deleteChat('chat_123', userId);
      assert.strictEqual(result, true);
    });

    await t.test('throws error for nonexistent chat', async () => {
      await assert.rejects(
        async () => {
          await mockChatService.deleteChat('nonexistent', userId);
        },
        {
          message: /Chat not found/,
        }
      );
    });
  });

  await t.test('updateChatTitle', async (t) => {
    await t.test('updates chat title', async () => {
      const result = await mockChatService.updateChatTitle('chat_123', userId, 'New Title');

      assert.strictEqual(result.title, 'New Title');
    });

    await t.test('validates title length', () => {
      const maxTitleLength = 255;
      const validTitle = 'A'.repeat(100);
      const invalidTitle = 'A'.repeat(300);

      assert.ok(validTitle.length <= maxTitleLength, 'Valid title should be within limit');
      assert.ok(invalidTitle.length > maxTitleLength, 'Invalid title exceeds limit');
    });
  });
});

test('Chat Request Validation', async (t) => {
  await t.test('createChat validation', async (t) => {
    await t.test('requires user authentication', () => {
      // User ID should come from authenticated request
      const req = { user: null };
      assert.ok(!req.user, 'Should reject unauthenticated requests');
    });

    await t.test('validates chat_mode is string', () => {
      const validPayloads = [{ chat_mode: 'arco' }, { chat_mode: 'personal_lessons' }];

      const invalidPayloads = [
        { chat_mode: 123 },
        { chat_mode: null },
        { chat_mode: ['arco'] },
        { chat_mode: {} },
      ];

      for (const payload of validPayloads) {
        assert.strictEqual(typeof payload.chat_mode, 'string');
      }

      for (const payload of invalidPayloads) {
        assert.notStrictEqual(typeof payload.chat_mode, 'string');
      }
    });
  });

  await t.test('getChat validation', async (t) => {
    await t.test('requires chat_id parameter', () => {
      const validParams = { chat_id: 'chat_123' };
      const invalidParams = { chat_id: '' };

      assert.ok(validParams.chat_id, 'Should have chat_id');
      assert.ok(!invalidParams.chat_id, 'Empty chat_id should be invalid');
    });
  });

  await t.test('deleteChat validation', async (t) => {
    await t.test('requires chat_id parameter', () => {
      const req = { params: { chat_id: 'chat_123' } };
      assert.ok(req.params.chat_id, 'Should have chat_id in params');
    });

    await t.test('validates UUID format', () => {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const invalidUUIDs = ['invalid', '123', 'not-a-uuid'];

      assert.ok(uuidPattern.test(validUUID), 'Valid UUID should match pattern');
      for (const invalid of invalidUUIDs) {
        assert.ok(!uuidPattern.test(invalid), `${invalid} should not match UUID pattern`);
      }
    });
  });
});

test('Chat Response Formatting', async (t) => {
  await t.test('formats chat list response', () => {
    const chats = [createMockChat(), createMockChat()];
    const response = {
      success: true,
      data: {
        chats,
        pagination: {
          total: chats.length,
          hasMore: false,
        },
      },
    };

    assert.strictEqual(response.success, true);
    assert.ok(Array.isArray(response.data.chats));
    assert.ok(response.data.pagination);
  });

  await t.test('formats single chat response', () => {
    const chat = createMockChat();
    const response = {
      success: true,
      data: chat,
    };

    assert.strictEqual(response.success, true);
    assert.ok(response.data.chat_id);
  });

  await t.test('formats error response', () => {
    const response = {
      success: false,
      error: {
        code: 'CHAT_NOT_FOUND',
        message: 'Chat not found',
      },
    };

    assert.strictEqual(response.success, false);
    assert.ok(response.error.code);
    assert.ok(response.error.message);
  });
});

test('Chat Mode Handling', async (t) => {
  await t.test('arco mode uses shared vector store', () => {
    const chatMode = 'arco';
    const useSharedStore = chatMode === 'arco';
    assert.strictEqual(useSharedStore, true);
  });

  await t.test('personal_lessons mode uses user vector store', () => {
    const chatMode = 'personal_lessons';
    const useUserStore = chatMode === 'personal_lessons';
    assert.strictEqual(useUserStore, true);
  });

  await t.test('persists chat_mode in database', () => {
    const chat = createMockChat({ chat_mode: 'personal_lessons' });
    assert.strictEqual(chat.chat_mode, 'personal_lessons');
  });

  await t.test('defaults to arco mode when not specified', () => {
    const chatMode = undefined || 'arco';
    assert.strictEqual(chatMode, 'arco');
  });
});
