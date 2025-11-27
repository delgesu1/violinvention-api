// Test setup helpers for violinvention-api
// Use this to create isolated test data and cleanup

const TEST_USER_PREFIX = 'e2e-test-';

// Generate a unique test user ID
const createTestUserId = () => `${TEST_USER_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Check if a user ID is a test user
const isTestUser = (userId) => userId && userId.startsWith(TEST_USER_PREFIX);

// Mock Supabase chain builder (for unit tests)
const makeSupabaseChain = (mockRows = {}) => {
  const chain = {
    _table: null,
    _filters: {},
    select: () => chain,
    eq: (col, val) => {
      chain._filters[col] = val;
      return chain;
    },
    in: () => chain,
    order: () => chain,
    gt: () => chain,
    single: async () => {
      const key = `${chain._table}:${chain._filters.user_id || chain._filters.chat_id}`;
      const row = mockRows[key];
      if (!row) return { data: null, error: { code: 'PGRST116' } };
      return { data: row, error: null };
    },
    maybeSingle: async () => {
      const key = `${chain._table}:${chain._filters.user_id || chain._filters.chat_id}`;
      const row = mockRows[key];
      return { data: row || null, error: null };
    },
    update: (updates) => ({
      eq: () => ({
        select: () => ({
          single: async () => {
            const key = `${chain._table}:${chain._filters.user_id}`;
            mockRows[key] = { ...(mockRows[key] || {}), ...updates };
            return { data: mockRows[key], error: null };
          },
        }),
      }),
    }),
    insert: (data) => ({
      select: () => ({
        single: async () => {
          const id = data.id || data.chat_id || data.user_id;
          const key = `${chain._table}:${id}`;
          mockRows[key] = data;
          return { data, error: null };
        },
      }),
    }),
    upsert: async () => ({ error: null }),
  };

  return {
    from: (table) => {
      chain._table = table;
      chain._filters = {};
      return chain;
    },
    _mockRows: mockRows,
  };
};

// Mock OpenAI client builder (for unit tests)
const makeOpenAIMock = (options = {}) => {
  const createdResponses = [];
  const createdFiles = [];
  const createdStores = [];

  return {
    responses: {
      create: async (payload) => {
        createdResponses.push(payload);
        return options.streamResponse || { output_text: 'Mock response' };
      },
    },
    vectorStores: {
      create: async (payload) => {
        const id = `vs_${createdStores.length + 1}`;
        createdStores.push({ id, payload });
        return { id };
      },
      files: {
        create: async (vsId, payload) => {
          const id = `vsfile_${Date.now()}`;
          return { id };
        },
      },
      search: async (vsId, payload) => ({
        data: options.searchResults || [],
      }),
    },
    files: {
      create: async (payload) => {
        const id = `file_${createdFiles.length + 1}`;
        createdFiles.push({ id, payload });
        return { id };
      },
      del: async (fileId) => ({ deleted: true }),
    },
    _created: {
      responses: createdResponses,
      files: createdFiles,
      stores: createdStores,
    },
  };
};

// Mock streaming response events
const createMockStreamEvents = () => [
  { type: 'response.created', data: { response_id: 'resp_1' } },
  { type: 'response.output_item.added', data: {} },
  { type: 'response.content_part.added', data: {} },
  { type: 'response.output_text.delta', data: { delta: 'Hello, ' } },
  { type: 'response.output_text.delta', data: { delta: 'how can I help?' } },
  { type: 'response.output_text.done', data: { text: 'Hello, how can I help?' } },
  { type: 'response.done', data: { response: { output: [{ content: [{ text: 'Hello, how can I help?' }] }] } } },
];

// Fixture: mock chat data
const createMockChat = (overrides = {}) => ({
  chat_id: `chat_${Date.now()}`,
  user_id: createTestUserId(),
  conversation_id: `conv_${Date.now()}`,
  title: 'Test Chat',
  chat_mode: 'arco',
  is_deleted: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// Fixture: mock message data
const createMockMessage = (chatId, role = 'user', overrides = {}) => ({
  message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  chat_id: chatId,
  role,
  content: role === 'user' ? 'Test user message' : 'Test assistant response',
  created_at: new Date().toISOString(),
  ...overrides,
});

module.exports = {
  TEST_USER_PREFIX,
  createTestUserId,
  isTestUser,
  makeSupabaseChain,
  makeOpenAIMock,
  createMockStreamEvents,
  createMockChat,
  createMockMessage,
};
