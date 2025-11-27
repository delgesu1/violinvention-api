// Ensure config validator has a NODE_ENV to satisfy config.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OPENAI_API_MODEL = process.env.OPENAI_API_MODEL || 'gpt-5';

const test = require('node:test');
const assert = require('node:assert');

const promptConfigService = require('../src/services/promptConfig.service');

test('promptConfig generates summary prompt with instrument/genre substitutions', () => {
  const prompt = promptConfigService.generateSummaryPrompt('violin', 'classical');
  assert.ok(prompt.includes('violin'));
  assert.ok(prompt.toLowerCase().includes('practice'));
});

test('promptConfig summary prompt includes structured JSON instructions', () => {
  const prompt = promptConfigService.generateSummaryPrompt('violin', 'classical');
  assert.ok(prompt.includes('STRUCTURED OUTPUT'));
  assert.ok(prompt.toLowerCase().includes('json object'));
  assert.ok(prompt.includes('"summary_markdown"'));
});

test('promptConfig validates instruments/genres', () => {
  assert.strictEqual(promptConfigService.isValidInstrument('violin'), true);
  assert.strictEqual(promptConfigService.isValidInstrument('nonexistent'), false);
  assert.strictEqual(promptConfigService.isValidGenre('classical'), true);
  assert.strictEqual(promptConfigService.isValidGenre('unknown'), false);
});
