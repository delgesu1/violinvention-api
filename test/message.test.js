// Message service unit tests
const test = require('node:test');
const assert = require('node:assert');

// Set up environment FIRST
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OPENAI_API_MODEL = 'gpt-5';
process.env.PROMPT_ID = 'prompt-arco';
process.env.PROMPT_VERSION = 'v1';
process.env.PROMPT_ID_PERSONAL_LESSONS = 'prompt-personal';
process.env.PROMPT_ID_DEEPTHINK = 'prompt-deepthink';
process.env.PROMPT_ID_LESSON_PLAN = 'prompt-lessonplan';

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
      globalSummaryPromptId: 'prompt-summary',
      kRawTurns: 3,
      summaryTokenCap: 500,
      promptTokenBudget: 3000,
      chunkSummarizeThreshold: 6000,
    },
  },
};

// Mock supabase
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
          gt: () => chain,
          single: async () => ({ data: null, error: { code: 'PGRST116' } }),
          maybeSingle: async () => ({ data: null, error: null }),
          update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
          upsert: async () => ({ error: null }),
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
      vectorStores: {
        create: async () => ({ id: 'vs_1' }),
        search: async () => ({ data: [] }),
      },
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
const messageService = require('../src/services/message.service');

test('messageService exports findAllMessages function', async () => {
  assert.ok(typeof messageService.findAllMessages === 'function', 'findAllMessages should be a function');
});

test('messageService exports sendMessage function', async () => {
  assert.ok(typeof messageService.sendMessage === 'function', 'sendMessage should be a function');
});

test('messageService exports sendFirstMessage function', async () => {
  assert.ok(typeof messageService.sendFirstMessage === 'function', 'sendFirstMessage should be a function');
});

test('messageService exports selectPromptConfig function', async () => {
  assert.ok(typeof messageService.selectPromptConfig === 'function', 'selectPromptConfig should be a function');
});

test('selectPromptConfig returns a config object', async () => {
  const config = messageService.selectPromptConfig({
    chatMode: 'arco',
    isDeepThink: false,
    isLessonPlan: false,
  });

  assert.ok(config !== undefined, 'Config should be returned');
});
