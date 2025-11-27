const test = require('node:test');
const assert = require('node:assert');

// Lightweight chainable supabase mock
const makeChain = () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    gt: () => chain,
    single: async () => ({ data: null, error: { code: 'PGRST116' } }),
    maybeSingle: async () => ({ data: null, error: { code: 'PGRST116' } }),
    upsert: async () => ({ error: null }),
  };
  return chain;
};

// Mock dependencies before requiring the service
const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = { exports: { supabase: { from: () => makeChain() } } };

const configPath = require.resolve('../src/config/config');
require.cache[configPath] = {
  exports: {
    memory: {
      globalSummaryPromptId: 'prompt-1',
      kRawTurns: 3,
      summaryTokenCap: 500,
      promptTokenBudget: 3000,
      chunkSummarizeThreshold: 10,
    },
  },
};

const openaiPath = require.resolve('../src/config/openai');
require.cache[openaiPath] = {
  exports: {
    openaiClient: {
      responses: {
        create: async () => ({ output_text: 'new summary text' }),
      },
    },
  },
};

const llmLoggerPath = require.resolve('../src/utils/llmLogger');
require.cache[llmLoggerPath] = {
  exports: {
    logLLMInput: () => {},
    logLLMOutput: () => {},
  },
};

const memoryService = require('../src/services/conversationMemory.service');

test('maybeUpdateGlobalSummary skips when below threshold', async () => {
  const brief = { global_summary: 'short', last_summarized_message_id: null };
  const turns = [
    { user: { content: 'hi', message_id: 'u1' }, assistant: { content: 'yo', message_id: 'a1' } },
  ];

  const result = await memoryService.maybeUpdateGlobalSummary({
    chatId: 'chat-low',
    userId: 'user-1',
    brief,
    turns,
    overrides: { chunkSummarizeThreshold: 1000, kRawTurns: 3 },
  });

  assert.strictEqual(result.summarized, false);
  assert.strictEqual(result.reason, 'below_threshold');
});

test('maybeUpdateGlobalSummary summarizes older turns and advances cursor', async () => {
  const brief = { global_summary: 'prev summary', last_summarized_message_id: null };
  const turns = [
    { user: { content: 'user one with enough text', message_id: 'u1' }, assistant: { content: 'assistant one', message_id: 'a1' } },
    { user: { content: 'user two with more text', message_id: 'u2' }, assistant: { content: 'assistant two', message_id: 'a2' } },
    { user: { content: 'user three', message_id: 'u3' }, assistant: { content: 'assistant three', message_id: 'a3' } },
    { user: { content: 'user four', message_id: 'u4' }, assistant: { content: 'assistant four', message_id: 'a4' } },
  ];

  const result = await memoryService.maybeUpdateGlobalSummary({
    chatId: 'chat-high',
    userId: 'user-2',
    brief,
    turns,
    overrides: { chunkSummarizeThreshold: 5, kRawTurns: 3, summaryTokenCap: 50, promptTokenBudget: 3000 },
  });

  assert.strictEqual(result.summarized, true);
  assert.strictEqual(result.brief.last_summarized_message_id, 'a1');
  assert.ok(result.brief.global_summary.includes('new summary text'));
});
