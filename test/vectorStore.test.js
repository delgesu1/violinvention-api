// Minimal env to satisfy config
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.OPENAI_API_MODEL = process.env.OPENAI_API_MODEL || 'gpt-5';

const test = require('node:test');
const assert = require('node:assert');

// Mock supabase
const supabasePath = require.resolve('../src/config/supabase');
const mockRows = {};
require.cache[supabasePath] = {
  exports: {
    supabase: {
      from: (table) => {
        const chain = {
          select: () => chain,
          eq: (col, val) => {
            chain.eqCol = col;
            chain.eqVal = val;
            return chain;
          },
          single: async () => {
            const key = `${table}:${chain.eqVal}`;
            const row = mockRows[key];
            if (!row) return { data: null, error: { code: 'PGRST116' } };
            return { data: row, error: null };
          },
          update: (updates) => {
            return {
              eq: () => ({
                select: () => ({
                  single: async () => {
                    const key = `${table}:${chain.eqVal}`;
                    mockRows[key] = { ...(mockRows[key] || {}), ...updates };
                    return { data: mockRows[key], error: null };
                  },
                }),
              }),
            };
          },
          insert: (updates) => ({
            select: () => ({
              single: async () => {
                const key = `${table}:${updates.user_id}`;
                mockRows[key] = updates;
                return { data: updates, error: null };
              },
            }),
          }),
        };
        return chain;
      },
    },
  },
};

// Mock openai client
const openaiPath = require.resolve('../src/config/openai');
const createdStores = [];
const createdFiles = [];
const addedFiles = [];
require.cache[openaiPath] = {
  exports: {
    openaiClient: {
      vectorStores: {
        create: async (payload) => {
          const id = `vs_${createdStores.length + 1}`;
          createdStores.push({ id, payload });
          return { id };
        },
        files: {
          create: async (vsId, payload) => {
            const id = `vsfile_${addedFiles.length + 1}`;
            addedFiles.push({ vsId, payload, id });
            return { id };
          },
        },
        search: async (vsId, payload) => ({
          data: [{ id: 'hit1', vsId, payload }],
        }),
      },
      files: {
        create: async (payload) => {
          const id = `file_${createdFiles.length + 1}`;
          createdFiles.push({ id, payload });
          return { id };
        },
      },
    },
  },
};

const vectorStore = require('../src/services/vectorStore.service');

test('searchVectorStore returns [] when user has no vector store', async () => {
  const results = await vectorStore.searchVectorStore('user-no-store', 'query', 3);
  assert.deepStrictEqual(results, []);
});

test('ensureVectorStore reuses existing id and avoids creating a new one', async () => {
  // Seed existing settings
  const key = 'user_settings:user-has-store';
  const supabaseCache = require.cache[supabasePath].exports.supabase;
  const existing = { user_id: 'user-has-store', vector_store_id: 'vs_existing' };
  // direct injection
  const mockRowsRef = require.cache[supabasePath].exports.supabase._rows || {};
  mockRowsRef[key] = existing;

  // Monkey-patch rows to share between calls
  supabaseCache._rows = mockRowsRef;
  mockRows[key] = existing;

  const id = await vectorStore.ensureVectorStore('user-has-store');
  assert.strictEqual(id, 'vs_existing');
  assert.strictEqual(createdStores.length, 0);
});

test('uploadLessonToVectorStore throws on missing fields', async () => {
  await assert.rejects(
    () => vectorStore.uploadLessonToVectorStore('user-1', null, 't', { lesson_id: 'l1' }),
    /summary/
  );
  await assert.rejects(
    () => vectorStore.uploadLessonToVectorStore('user-1', 's', null, { lesson_id: 'l1' }),
    /transcript/
  );
  await assert.rejects(
    () => vectorStore.uploadLessonToVectorStore('user-1', 's', 't', { lesson_id: null }),
    /lesson_id/
  );
});

test('searchVectorStore uses search when store exists', async () => {
  // Seed store
  const key = 'user_settings:user-with-store';
  mockRows[key] = { user_id: 'user-with-store', vector_store_id: 'vs_42' };
  const results = await vectorStore.searchVectorStore('user-with-store', 'bow hold', 2);
  assert.ok(Array.isArray(results));
  assert.strictEqual(results[0].vsId, 'vs_42');
});
