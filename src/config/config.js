const dotenv = require('dotenv');
const path = require('path');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(8080),
    // JWT configuration removed - using Supabase authentication
    // JWT_SECRET: Joi.string().required().description('JWT secret key'),
    // JWT_ACCESS_EXPIRATION_DAYS: Joi.string().required().description('JWT expiration days'),
    
    OPENAI_API_KEY:Joi.string().required(),
    OPENAI_PROJECT_ID:Joi.string().optional(), // Required for project-scoped keys (sk-proj-...)
    PROMPT_ID:Joi.string().optional(), // New Responses API
    PROMPT_VERSION:Joi.string().optional(),
    PROMPT_INSTRUCTIONS:Joi.string().optional(),
    PROMPT_ID_PERSONAL_LESSONS:Joi.string().optional(),
    PROMPT_VERSION_PERSONAL_LESSONS:Joi.string().optional(),
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS:Joi.string().optional(),
    PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE:Joi.string().optional(),
    PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE:Joi.string().optional(),
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE:Joi.string().optional(),
    PROMPT_ID_DEEPTHINK:Joi.string().optional(),
    PROMPT_VERSION_DEEPTHINK:Joi.string().optional(),
    PROMPT_INSTRUCTIONS_DEEPTHINK:Joi.string().optional(),
    VECTOR_STORE_ID:Joi.string().optional(), // Vector store for knowledge base
    ASSISTANT_ID:Joi.string().optional(), // Legacy, optional for migration
    OPENAI_API_MODEL:Joi.string().required(),

    OPENAI_API_KEY_BOT:Joi.string().optional(),
    OPENAI_PROJECT_ID_BOT:Joi.string().optional(), // Required for project-scoped keys (sk-proj-...)
    PROMPT_ID_BOT:Joi.string().optional(), // New Responses API for bot
    ASSISTANT_ID_BOT:Joi.string().optional(), // Legacy, optional for migration
    OPENAI_API_MODEL_BOT:Joi.string().optional(),

    MEMORY_K_RAW_TURNS: Joi.number().integer().min(1).default(3),
    MEMORY_SUMMARY_TOKEN_CAP: Joi.number().integer().min(100).default(500),
    MEMORY_PROMPT_TOKEN_BUDGET: Joi.number().integer().min(500).default(3000),
    MEMORY_CHUNK_SUMMARIZE_THRESHOLD: Joi.number().integer().min(500).default(6000),
    MEMORY_SUMMARIZER_MODEL: Joi.string().optional(),
    PROMPT_ID_SUMMARY_GLOBAL: Joi.string().optional(),
    PROMPT_VERSION_SUMMARY_GLOBAL: Joi.string().optional(),

  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  // JWT configuration removed - using Supabase authentication
  // jwt: {
  //   secret: envVars.JWT_SECRET,
  //   accessExpirationDays: envVars.JWT_ACCESS_EXPIRATION_DAYS
  // },
  openai:{
    mainClient:{
      key: envVars.OPENAI_API_KEY,
      projectId: envVars.OPENAI_PROJECT_ID, // Required for project-scoped keys
      promptId: envVars.PROMPT_ID || 'pmpt_68a813200634819093ee3c75a18916b00f89c46dc51e879f',
      promptVersion: envVars.PROMPT_VERSION || '38',
      promptInstructions: envVars.PROMPT_INSTRUCTIONS || null,
      vectorStoreId: envVars.VECTOR_STORE_ID || 'vs_rnnqexe2zwkUBkn5NInfTRt4', // Legacy, kept for migration
      assistantId: envVars.ASSISTANT_ID, // Legacy, kept for migration
      model: envVars.OPENAI_API_MODEL || 'gpt-5',
      personalLessonsPromptId: envVars.PROMPT_ID_PERSONAL_LESSONS || 'pmpt_690724bdde1081949ff40ab0fcd6486209aaa8aad0425664',
      personalLessonsPromptVersion: envVars.PROMPT_VERSION_PERSONAL_LESSONS || '1',
      personalLessonsPromptInstructions: envVars.PROMPT_INSTRUCTIONS_PERSONAL_LESSONS || null,
      personalLessonsDeepDivePromptId: envVars.PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE || 'pmpt_690723b2773c819393cc4536e64b882c0abf664c9de35b31',
      personalLessonsDeepDivePromptVersion: envVars.PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE || '2',
      personalLessonsDeepDivePromptInstructions: envVars.PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE || null,
      deepThinkPromptId: envVars.PROMPT_ID_DEEPTHINK || 'pmpt_68e6212f66648190b909ceeba3e2b514051a81413723cdec',
      deepThinkPromptVersion: envVars.PROMPT_VERSION_DEEPTHINK || '3',
      deepThinkPromptInstructions: envVars.PROMPT_INSTRUCTIONS_DEEPTHINK || null,
    },
    botClient:{
      key: envVars.OPENAI_API_KEY_BOT || envVars.OPENAI_API_KEY,
      projectId: envVars.OPENAI_PROJECT_ID_BOT || envVars.OPENAI_PROJECT_ID, // Required for project-scoped keys
      promptId: envVars.PROMPT_ID_BOT || 'pmpt_68ae7e8cdf708193afe84839f885f83f0bde76623c4cf917',
      promptVersion: envVars.PROMPT_VERSION_BOT || '1',
      assistantId: envVars.ASSISTANT_ID_BOT, // Legacy
      model: envVars.OPENAI_API_MODEL_BOT || 'gpt-5-nano',
    }
  },
  memory: {
    kRawTurns: envVars.MEMORY_K_RAW_TURNS,
    summaryTokenCap: envVars.MEMORY_SUMMARY_TOKEN_CAP,
    promptTokenBudget: envVars.MEMORY_PROMPT_TOKEN_BUDGET,
    chunkSummarizeThreshold: envVars.MEMORY_CHUNK_SUMMARIZE_THRESHOLD,
    summarizerModel: envVars.MEMORY_SUMMARIZER_MODEL || 'gpt-5.1-nano',
    globalSummaryPromptId: envVars.PROMPT_ID_SUMMARY_GLOBAL || 'pmpt_6917ebe9367c819396fe4840cf0f0e050c18a965a3366120',
    globalSummaryPromptVersion: envVars.PROMPT_VERSION_SUMMARY_GLOBAL || '1'
  }
};
