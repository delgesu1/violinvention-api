const fs = require('fs');
const path = require('path');
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { openaiClient, PROMPT_ID, PROMPT_ID_PERSONAL_LESSONS } = require('../config/openai');

const promptCache = new Map();
const inflightFetches = new Map();
const fallbackInstructionsCache = new Map();

const FALLBACK_PROMPT_PATHS = new Map([
  [PROMPT_ID, path.join(__dirname, '../prompts/arcoai.md')],
  [PROMPT_ID_PERSONAL_LESSONS, path.join(__dirname, '../prompts/personal_lessons.md')],
]);

const cacheKeyFor = (promptId, promptVersion) => `${promptId || 'default'}:${promptVersion || 'latest'}`;

const normalizeContentToString = (content) => {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(normalizeContentToString).filter(Boolean).join('\n');
  }

  if (typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }
    if (typeof content.value === 'string') {
      return content.value;
    }
    if (typeof content.content === 'string') {
      return content.content;
    }
    if (Array.isArray(content.content)) {
      return normalizeContentToString(content.content);
    }
  }

  return '';
};

const normalizePromptMessages = (rawMessages = []) => {
  return rawMessages
    .map((message) => {
      if (!message) {
        return null;
      }

      const role = message.role || 'developer';
      const text = normalizeContentToString(message.content);

      if (!text) {
        return null;
      }

      return {
        role,
        content: [{ type: 'input_text', text }],
      };
    })
    .filter(Boolean);
};

const extractMessagesArray = (promptDefinition) => {
  if (!promptDefinition) {
    return null;
  }

  if (Array.isArray(promptDefinition.content)) {
    return promptDefinition.content;
  }

  if (Array.isArray(promptDefinition.messages)) {
    return promptDefinition.messages;
  }

  if (promptDefinition.prompt) {
    if (Array.isArray(promptDefinition.prompt.content)) {
      return promptDefinition.prompt.content;
    }
    if (Array.isArray(promptDefinition.prompt.messages)) {
      return promptDefinition.prompt.messages;
    }
  }

  if (promptDefinition.definition) {
    if (Array.isArray(promptDefinition.definition.content)) {
      return promptDefinition.definition.content;
    }
    if (Array.isArray(promptDefinition.definition.messages)) {
      return promptDefinition.definition.messages;
    }
  }

  return null;
};

const buildFallbackMessages = (instructions) => {
  if (!instructions) {
    return null;
  }

  const text = instructions.trim();
  if (!text) {
    return null;
  }

  return [
    {
      role: 'developer',
      content: [{ type: 'input_text', text }],
    },
  ];
};

const fetchPromptDefinition = async (promptId, promptVersion) => {
  const params = {};
  if (promptVersion) {
    params.version = promptVersion;
  }

  try {
    return await openaiClient.prompts.retrieve(promptId, params);
  } catch (error) {
    console.error('[PromptFetch] retrieve failed', {
      promptId,
      promptVersion,
      status: error?.status,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
};

const loadFallbackInstructionsFromFile = (promptId) => {
  if (!promptId) {
    return null;
  }

  const filePath = FALLBACK_PROMPT_PATHS.get(promptId);
  if (!filePath) {
    return null;
  }

  if (fallbackInstructionsCache.has(filePath)) {
    return fallbackInstructionsCache.get(filePath);
  }

  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const normalized = contents.trim();
    fallbackInstructionsCache.set(filePath, normalized.length > 0 ? normalized : null);
    return fallbackInstructionsCache.get(filePath);
  } catch (error) {
    console.warn(`[PromptFallback] Unable to read fallback instructions for ${promptId}: ${error.message}`);
    fallbackInstructionsCache.set(filePath, null);
    return null;
  }
};

const getPromptMessages = async ({ promptId, promptVersion, fallbackInstructions } = {}) => {
  const cacheKey = cacheKeyFor(promptId, promptVersion);

  if (promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey);
  }

  if (!promptId) {
    const fallback = buildFallbackMessages(fallbackInstructions);
    if (fallback) {
      promptCache.set(cacheKey, fallback);
      return fallback;
    }

    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Prompt ID is required to resolve instructions');
  }

  if (inflightFetches.has(cacheKey)) {
    return inflightFetches.get(cacheKey);
  }

  const fetchPromise = (async () => {
    try {
      const promptDefinition = await fetchPromptDefinition(promptId, promptVersion);
      const messagesArray = extractMessagesArray(promptDefinition);
      const normalized = normalizePromptMessages(messagesArray);

      if (normalized.length === 0) {
        const fallbackInstructionSource = fallbackInstructions || loadFallbackInstructionsFromFile(promptId);
        const fallback = buildFallbackMessages(fallbackInstructionSource);
        if (fallback) {
          promptCache.set(cacheKey, fallback);
          return fallback;
        }

        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Prompt ${promptId} returned no usable messages`);
      }

      promptCache.set(cacheKey, normalized);
      return normalized;
    } catch (error) {
      const fallbackInstructionSource = fallbackInstructions || loadFallbackInstructionsFromFile(promptId);
      const fallback = buildFallbackMessages(fallbackInstructionSource);
      if (fallback) {
        promptCache.set(cacheKey, fallback);
        return fallback;
      }

      throw error;
    } finally {
      inflightFetches.delete(cacheKey);
    }
  })();

  inflightFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
};

module.exports = {
  getPromptMessages,
};
