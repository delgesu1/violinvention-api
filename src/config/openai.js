const OpenAI = require("openai");
const config = require("./config");

// New Responses API configuration
const PROMPT_ID = config.openai.mainClient.promptId;
const PROMPT_VERSION = config.openai.mainClient.promptVersion;
const PROMPT_INSTRUCTIONS = config.openai.mainClient.promptInstructions;
const VECTOR_STORE_ID = config.openai.mainClient.vectorStoreId; // Legacy, kept for migration
const OPENAI_MODEL = config.openai.mainClient.model;
const PROMPT_ID_PERSONAL_LESSONS = config.openai.mainClient.personalLessonsPromptId;
const PROMPT_VERSION_PERSONAL_LESSONS = config.openai.mainClient.personalLessonsPromptVersion;
const PROMPT_INSTRUCTIONS_PERSONAL_LESSONS = config.openai.mainClient.personalLessonsPromptInstructions;
const PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE = config.openai.mainClient.personalLessonsDeepDivePromptId;
const PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE = config.openai.mainClient.personalLessonsDeepDivePromptVersion;
const PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE = config.openai.mainClient.personalLessonsDeepDivePromptInstructions;
const PROMPT_ID_DEEPTHINK = config.openai.mainClient.deepThinkPromptId;
const PROMPT_VERSION_DEEPTHINK = config.openai.mainClient.deepThinkPromptVersion;
const PROMPT_INSTRUCTIONS_DEEPTHINK = config.openai.mainClient.deepThinkPromptInstructions;
const PROMPT_ID_LESSON_PLAN = config.openai.mainClient.lessonPlanPromptId;
const PROMPT_VERSION_LESSON_PLAN = config.openai.mainClient.lessonPlanPromptVersion;
const PROMPT_INSTRUCTIONS_LESSON_PLAN = config.openai.mainClient.lessonPlanPromptInstructions;

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
  project: config.openai.mainClient.projectId, // Required for project-scoped keys (sk-proj-...)
});

const botClient = new OpenAI({
  apiKey: config.openai.botClient.key,
  project: config.openai.botClient.projectId, // Required for project-scoped keys (sk-proj-...)
});

module.exports = {
  // New Responses API exports
  PROMPT_ID,
  PROMPT_VERSION,
  PROMPT_INSTRUCTIONS,
  VECTOR_STORE_ID, // Legacy, kept for migration
  PROMPT_ID_PERSONAL_LESSONS,
  PROMPT_VERSION_PERSONAL_LESSONS,
  PROMPT_INSTRUCTIONS_PERSONAL_LESSONS,
  PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE,
  PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE,
  PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE,
  PROMPT_ID_DEEPTHINK,
  PROMPT_VERSION_DEEPTHINK,
  PROMPT_INSTRUCTIONS_DEEPTHINK,
  PROMPT_ID_LESSON_PLAN,
  PROMPT_VERSION_LESSON_PLAN,
  PROMPT_INSTRUCTIONS_LESSON_PLAN,
  OPENAI_MODEL,
  openaiClient,
  
  // Bot configuration
  PROMPT_ID_BOT,
  PROMPT_VERSION_BOT,
  OPENAI_MODEL_BOT,
  botClient,
  
  // Legacy exports (keep for migration)
  ASSISTANT_ID,
  ASSISTANT_ID_BOT,
};
