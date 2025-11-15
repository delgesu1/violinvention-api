const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { openaiClient } = require('../config/openai');
const promptConfigService = require('./promptConfig.service');
const logger = require('../config/logger');
const { logLLMInput, logLLMOutput } = require('../utils/llmLogger');

const SUMMARIZATION_MODEL = 'gpt-5';
const TAG_EXTRACTION_MODEL = 'gpt-5-nano';
const TITLE_MODEL = 'gpt-5-nano';

const DEFAULT_INSTRUMENT = 'violin';
const DEFAULT_GENRE = 'classical';

const extractOutputText = (resp) => {
  try {
    if (!resp || !Array.isArray(resp.output)) {
      return null;
    }
    const messageItem = resp.output.find((item) => item && item.type === 'message');
    if (!messageItem || !Array.isArray(messageItem.content)) {
      return null;
    }
    const textParts = messageItem.content
      .filter((chunk) => chunk && chunk.type === 'output_text' && typeof chunk.text === 'string')
      .map((chunk) => chunk.text);
    return textParts.length ? textParts.join('') : null;
  } catch (error) {
    logger.error('[RecordingProcessing] Failed to extract output text', error);
    return null;
  }
};

const isValidStudentName = (candidate) => {
  if (!candidate || typeof candidate !== 'string') {
    return false;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }
  const lowered = trimmed.toLowerCase();
  const blocked = new Set(['unknown', 'n/a', 'na', 'student', 'none', 'null', 'not specified']);
  return !blocked.has(lowered);
};

const parseStudentNameFromText = (rawText) => {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'student')) {
        const candidate = parsed.student;
        if (typeof candidate === 'string' && isValidStudentName(candidate)) {
          return candidate.trim();
        }
        return null;
      }
    } catch (error) {
      logger.warn('[RecordingProcessing] Failed to parse JSON student response', error);
    }
  }

  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([\w\s]+):\s*(.+)$/i);
    if (match) {
      const [, category, name] = match;
      const normalizedCategory = category.trim().toLowerCase();
      if (normalizedCategory === 'student' || normalizedCategory === 'student name') {
        if (isValidStudentName(name)) {
          return name.trim();
        }
      }
    }
  }

  if (!trimmed.includes(':') && !trimmed.includes('\n') && isValidStudentName(trimmed)) {
    return trimmed;
  }

  return null;
};

const callResponsesApi = async ({ model, instructions, input, options = {} }) => {
  const payload = {
    model,
    instructions,
    input,
    store: false,
    ...options,
  };

  logLLMInput('recordingProcessing.callResponsesApi', `Instructions:\n${instructions}\n\nInput:\n${input}`, {
    model,
  });

  const response = await openaiClient.responses.create(payload);
  const text = extractOutputText(response);
  if (!text || !text.trim()) {
    throw new ApiError(httpStatus.BAD_GATEWAY, 'OpenAI returned an empty response');
  }
  logLLMOutput('recordingProcessing.callResponsesApi', text, { model });
  return text.trim();
};

const normalizePreference = (value, validator, fallback) => {
  if (value && validator(value)) {
    return value;
  }
  return fallback;
};

const processRecording = async ({ transcript, instrumentPreference, genrePreference }) => {
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Transcript is required to process recording');
  }

  const instrument = normalizePreference(
    instrumentPreference,
    (val) => promptConfigService.isValidInstrument(val),
    DEFAULT_INSTRUMENT
  );
  const genre = normalizePreference(
    genrePreference,
    (val) => promptConfigService.isValidGenre(val),
    DEFAULT_GENRE
  );

  logger.info('[RecordingProcessing] Starting summarization via Responses API', { instrument, genre });

  const summaryPrompt = promptConfigService.generateSummaryPrompt(instrument, genre);
  const summary = await callResponsesApi({
    model: SUMMARIZATION_MODEL,
    instructions: summaryPrompt,
    input: transcript,
    options: {
      text: { format: { type: 'text' }, verbosity: 'low' },
      reasoning: { effort: 'low' },
    },
  });

  let studentTag = null;
  let rawTagResponse = null;

  try {
    const tagInstructions = promptConfigService.generateTagExtractionPrompt(instrument, genre);
    rawTagResponse = await callResponsesApi({
      model: TAG_EXTRACTION_MODEL,
      instructions: tagInstructions,
      input: summary,
    });
    studentTag = parseStudentNameFromText(rawTagResponse);
  } catch (error) {
    logger.warn('[RecordingProcessing] Tag extraction failed, continuing without student tag', error);
  }

  let title = null;
  try {
    let titleInstructions = promptConfigService.generateTitlePrompt(instrument, genre, Boolean(studentTag));
    if (studentTag) {
      titleInstructions = titleInstructions.replace('{{STUDENT_NAME}}', studentTag);
    }
    title = await callResponsesApi({
      model: TITLE_MODEL,
      instructions: titleInstructions,
      input: summary,
    });
  } catch (error) {
    logger.warn('[RecordingProcessing] Title generation failed, continuing without title', error);
  }

  return {
    summary,
    studentTag,
    rawTagResponse,
    title,
  };
};

module.exports = {
  processRecording,
};
