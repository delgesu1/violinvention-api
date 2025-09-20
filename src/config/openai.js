const OpenAI = require("openai");
const config = require("./config");

// New Responses API configuration
const PROMPT_ID = config.openai.mainClient.promptId;
const PROMPT_VERSION = config.openai.mainClient.promptVersion;
const VECTOR_STORE_ID = config.openai.mainClient.vectorStoreId; // Legacy, kept for migration
const OPENAI_MODEL = config.openai.mainClient.model;

// Legacy Assistants API configuration (kept for backward compatibility)
const ASSISTANT_ID = config.openai.mainClient.assistantId;

// Bot client configuration (if needed)
const PROMPT_ID_BOT = config.openai.botClient.promptId;
const PROMPT_VERSION_BOT = config.openai.botClient.promptVersion;
const OPENAI_MODEL_BOT = config.openai.botClient.model;
const ASSISTANT_ID_BOT = config.openai.botClient.assistantId;

// Updated for OpenAI SDK 5.x with Responses API
const openaiClient = new OpenAI({
  apiKey: config.openai.mainClient.key,
});

const botClient = new OpenAI({
  apiKey: config.openai.botClient.key,
});

module.exports = {
  // New Responses API exports
  PROMPT_ID,
  PROMPT_VERSION,
  VECTOR_STORE_ID, // Legacy, kept for migration
  openaiClient,
  
  // Bot configuration
  PROMPT_ID_BOT,
  PROMPT_VERSION_BOT,
  botClient,
  
  // Legacy exports (keep for migration)
  ASSISTANT_ID,
  ASSISTANT_ID_BOT,
};
