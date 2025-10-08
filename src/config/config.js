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
    PROMPT_ID_PERSONAL_LESSONS:Joi.string().optional(),
    PROMPT_VERSION_PERSONAL_LESSONS:Joi.string().optional(),
    VECTOR_STORE_ID:Joi.string().optional(), // Vector store for knowledge base
    ASSISTANT_ID:Joi.string().optional(), // Legacy, optional for migration
    OPENAI_API_MODEL:Joi.string().required(),

    OPENAI_API_KEY_BOT:Joi.string().optional(),
    OPENAI_PROJECT_ID_BOT:Joi.string().optional(), // Required for project-scoped keys (sk-proj-...)
    PROMPT_ID_BOT:Joi.string().optional(), // New Responses API for bot
    ASSISTANT_ID_BOT:Joi.string().optional(), // Legacy, optional for migration
    OPENAI_API_MODEL_BOT:Joi.string().optional(),

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
      promptVersion: envVars.PROMPT_VERSION || '35',
      vectorStoreId: envVars.VECTOR_STORE_ID || 'vs_rnnqexe2zwkUBkn5NInfTRt4', // Legacy, kept for migration
      assistantId: envVars.ASSISTANT_ID, // Legacy, kept for migration
      model: envVars.OPENAI_API_MODEL || 'gpt-5',
      personalLessonsPromptId: envVars.PROMPT_ID_PERSONAL_LESSONS || 'pmpt_68e5827e6b9881938d5ab3b67db7e72509246b40d798fce0',
      personalLessonsPromptVersion: envVars.PROMPT_VERSION_PERSONAL_LESSONS || '1',
    },
    botClient:{
      key: envVars.OPENAI_API_KEY_BOT || envVars.OPENAI_API_KEY,
      projectId: envVars.OPENAI_PROJECT_ID_BOT || envVars.OPENAI_PROJECT_ID, // Required for project-scoped keys
      promptId: envVars.PROMPT_ID_BOT || 'pmpt_68ae7e8cdf708193afe84839f885f83f0bde76623c4cf917',
      promptVersion: envVars.PROMPT_VERSION_BOT || '1',
      assistantId: envVars.ASSISTANT_ID_BOT, // Legacy
      model: envVars.OPENAI_API_MODEL_BOT || 'gpt-5-nano',
    }
  }
};
