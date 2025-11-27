// Minimal env to satisfy config
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OPENAI_API_MODEL = process.env.OPENAI_API_MODEL || 'gpt-5';

const test = require('node:test');
const assert = require('node:assert');

// Mock openai config values to make assertions deterministic
const openaiPath = require.resolve('../src/config/openai');
require.cache[openaiPath] = {
  exports: {
    PROMPT_ID: 'arco-standard',
    PROMPT_INSTRUCTIONS: 'arco-standard-inst',
    PROMPT_ID_PERSONAL_LESSONS: 'pl-standard',
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS: 'pl-standard-inst',
    PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE: 'pl-deep',
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE: 'pl-deep-inst',
    PROMPT_ID_DEEPTHINK: 'arco-deep',
    PROMPT_INSTRUCTIONS_DEEPTHINK: 'arco-deep-inst',
    PROMPT_ID_LESSON_PLAN: 'lesson-plan',
    PROMPT_INSTRUCTIONS_LESSON_PLAN: 'lesson-plan-inst',
  },
};

const { selectPromptConfig } = require('../src/services/message.service');

test('lesson plan prompt overrides all modes/models', () => {
  const cfg = selectPromptConfig({ chat_mode: 'personal_lessons', model: 'arco-pro', lesson_plan_prompt: true });
  assert.strictEqual(cfg.promptId, 'lesson-plan');
  assert.strictEqual(cfg.promptInstructions, 'lesson-plan-inst');
  assert.strictEqual(cfg.includeVectorSearch, false);
});

test('personal lessons standard uses personal prompts and vector search', () => {
  const cfg = selectPromptConfig({ chat_mode: 'personal_lessons', model: 'arco' });
  assert.strictEqual(cfg.promptId, 'pl-standard');
  assert.strictEqual(cfg.promptInstructions, 'pl-standard-inst');
  assert.strictEqual(cfg.includeVectorSearch, true);
  assert.strictEqual(cfg.modelVariant, 'personal_lessons:standard');
});

test('personal lessons deep dive prefers personal deep dive prompts, falls back to deep think', () => {
  const cfg = selectPromptConfig({ chat_mode: 'personal_lessons', model: 'arco-pro' });
  assert.strictEqual(cfg.promptId, 'pl-deep'); // uses personal deep dive first
  assert.strictEqual(cfg.promptInstructions, 'pl-deep-inst');
  assert.strictEqual(cfg.includeVectorSearch, true);
  assert.strictEqual(cfg.modelVariant, 'personal_lessons:deep_dive');
});

test('personal lessons with invalid model still uses standard personal prompts and vector search', () => {
  const cfg = selectPromptConfig({ chat_mode: 'personal_lessons', model: 'weird-model' });
  assert.strictEqual(cfg.promptId, 'pl-standard');
  assert.strictEqual(cfg.promptInstructions, 'pl-standard-inst');
  assert.strictEqual(cfg.includeVectorSearch, true);
  assert.strictEqual(cfg.modelVariant, 'personal_lessons:standard');
});

test('arco deep dive uses deep think prompts, vector search disabled', () => {
  const cfg = selectPromptConfig({ chat_mode: 'arcoai', model: 'arco-pro' });
  assert.strictEqual(cfg.promptId, 'arco-deep');
  assert.strictEqual(cfg.promptInstructions, 'arco-deep-inst');
  assert.strictEqual(cfg.includeVectorSearch, false);
  assert.strictEqual(cfg.modelVariant, 'arco:deep_dive');
});

test('defaults to arco standard when mode/model are unknown', () => {
  const cfg = selectPromptConfig({ chat_mode: 'unknown', model: 'weird' });
  assert.strictEqual(cfg.promptId, 'arco-standard');
  assert.strictEqual(cfg.promptInstructions, 'arco-standard-inst');
  assert.strictEqual(cfg.includeVectorSearch, false);
});
