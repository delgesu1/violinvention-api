const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { openaiClient } = require('../config/openai');
const promptConfigService = require('./promptConfig.service');
const logger = require('../config/logger');
const { logLLMInput, logLLMOutput } = require('../utils/llmLogger');

const SUMMARIZATION_MODEL = 'gpt-5.1-2025-11-13';

const DEFAULT_INSTRUMENT = 'violin';
const DEFAULT_GENRE = 'classical';
const MAX_TITLE_LENGTH = 180;

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

const safeStringArray = (value, maxItems = 5) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
};

const extractStudentFromSummaryMarkdown = (summaryMarkdown) => {
  if (!summaryMarkdown || typeof summaryMarkdown !== 'string') {
    return null;
  }
  const lines = summaryMarkdown.split('\n');
  for (const line of lines) {
    const normalized = line.trim().replace(/^\-\s*/, '');
    const match = normalized.match(/^(?:\*\*)?Student(?:\*\*)?:\s*(.+)$/i);
    if (match) {
      const candidate = match[1].trim();
      if (isValidStudentName(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

const parseStructuredSummaryResponse = (rawText) => {
  const baseResult = {
    raw: rawText,
    summaryMarkdown: null,
    student: null,
    title: null,
    pieces: [],
    themes: [],
    parsed: null,
  };

  if (!rawText || typeof rawText !== 'string') {
    return baseResult;
  }

  try {
    const parsed = JSON.parse(rawText);
    baseResult.parsed = parsed;

    if (parsed && typeof parsed.summary_markdown === 'string' && parsed.summary_markdown.trim()) {
      baseResult.summaryMarkdown = parsed.summary_markdown.trim();
    }

    if (parsed && isValidStudentName(parsed.student)) {
      baseResult.student = parsed.student.trim();
    }

    if (parsed && typeof parsed.title === 'string' && parsed.title.trim()) {
      baseResult.title = parsed.title.trim();
    }

    baseResult.pieces = safeStringArray(parsed.pieces, 5);
    baseResult.themes = safeStringArray(parsed.themes, 5);
  } catch (error) {
    logger.warn('[RecordingProcessing] Failed to parse structured JSON summary', error);
  }

  return baseResult;
};

const buildTitle = ({ student, pieces = [], themes = [], maxLength = MAX_TITLE_LENGTH }) => {
  const piecePart = pieces.join(', ');
  const themePart = themes.join(', ');

  let content = piecePart && themePart ? `${piecePart}; ${themePart}` : piecePart || themePart || '';

  if (!content) {
    return student ? `${student}: Lesson` : null;
  }

  if (content.length > maxLength && themePart) {
    content = piecePart;
  }

  if (content.length > maxLength) {
    content = content.slice(0, maxLength - 1).trimEnd();
    if (content.endsWith(',')) {
      content = content.slice(0, -1).trimEnd();
    }
  }

  if (student) {
    return `${student}: ${content}`;
  }

  return content;
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
  const rawStructuredResponse = await callResponsesApi({
    model: SUMMARIZATION_MODEL,
    instructions: summaryPrompt,
    input: `Return a JSON object as specified. Transcript follows:\n${transcript}`,
    options: {
      text: { format: { type: 'json_object' }, verbosity: 'low' },
      reasoning: { effort: 'low' },
    },
  });

  const { summaryMarkdown, student, title: structuredTitle, pieces, themes, parsed } =
    parseStructuredSummaryResponse(rawStructuredResponse);

  if (!summaryMarkdown) {
    throw new ApiError(httpStatus.BAD_GATEWAY, 'OpenAI returned an invalid structured summary');
  }

  const studentTag = student || extractStudentFromSummaryMarkdown(summaryMarkdown);
  const title = structuredTitle || buildTitle({ student: studentTag, pieces, themes });

  return {
    summary: summaryMarkdown,
    studentTag,
    rawTagResponse: rawStructuredResponse,
    title,
    pieces,
    themes,
    rawStructuredParsed: parsed,
  };
};

module.exports = {
  processRecording,
};
