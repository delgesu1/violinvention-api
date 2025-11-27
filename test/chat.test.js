// Chat service unit tests
const test = require('node:test');
const assert = require('node:assert');

// Set up environment before any imports
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OPENAI_API_MODEL = 'gpt-5';
process.env.PROMPT_ID = 'prompt-arco';
process.env.PROMPT_VERSION = 'v1';

// Mock config FIRST before anything else loads
const configPath = require.resolve('../src/config/config');
require.cache[configPath] = {
  exports: {
    openai: {
      mainClient: {
        promptId: 'prompt-default',
        promptVersion: 'v1',
      },
    },
    chat: {
      defaultPromptId: 'prompt-default',
    },
    memory: {
      kRawTurns: 3,
    },
  },
};

// Mock supabase
const mockRows = {};
const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  exports: {
    supabase: {
      from: (table) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          single: async () => ({ data: null, error: { code: 'PGRST116' } }),
          maybeSingle: async () => ({ data: null, error: null }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
        };
        return chain;
      },
    },
  },
};

// Mock OpenAI client
const openaiPath = require.resolve('../src/config/openai');
require.cache[openaiPath] = {
  exports: {
    openaiClient: {
      responses: { create: async () => ({ output_text: 'mock' }) },
      vectorStores: { create: async () => ({ id: 'vs_1' }) },
    },
    PROMPT_ID: 'prompt-default',
    PROMPT_VERSION: 'v1',
  },
};

// Mock logger
const llmLoggerPath = require.resolve('../src/utils/llmLogger');
require.cache[llmLoggerPath] = {
  exports: {
    logLLMInput: () => {},
    logLLMOutput: () => {},
  },
};

// NOW require the service
const chatService = require('../src/services/chat.service');

test('chatService exports createChat function', async () => {
  assert.ok(typeof chatService.createChat === 'function', 'createChat should be a function');
});

test('chatService exports updateChat function', async () => {
  assert.ok(typeof chatService.updateChat === 'function', 'updateChat should be a function');
});

test('chatService exports deleteChat function', async () => {
  assert.ok(typeof chatService.deleteChat === 'function', 'deleteChat should be a function');
});

test('chatService exports getAllChats function', async () => {
  assert.ok(typeof chatService.getAllChats === 'function', 'getAllChats should be a function');
});

test('chatService exports createChatWithFirstMessage function', async () => {
  assert.ok(typeof chatService.createChatWithFirstMessage === 'function', 'createChatWithFirstMessage should be a function');
});
