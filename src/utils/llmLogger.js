const MAX_LOG_CHARS = 2000;
const DEFAULT_SENTENCE_PREVIEW_OUTPUT = 3;
const DEFAULT_SENTENCE_PREVIEW_INPUT = 5;

const formatForLog = (text = '') => {
  if (typeof text !== 'string') {
    return text;
  }
  if (text.length <= MAX_LOG_CHARS) {
    return text;
  }
  const trimmed = text.slice(0, MAX_LOG_CHARS);
  return `${trimmed}… [truncated ${text.length - MAX_LOG_CHARS} chars]`;
};

const limitToSentences = (text = '', maxSentences = DEFAULT_SENTENCE_PREVIEW_OUTPUT) => {
  if (typeof text !== 'string' || !text.trim()) {
    return text;
  }

  let sentenceCount = 0;
  let idx = 0;
  const len = text.length;

  while (idx < len && sentenceCount < maxSentences) {
    const char = text[idx];
    if (char === '.' || char === '!' || char === '?') {
      sentenceCount += 1;
      // Skip repeated punctuation like ellipses to avoid counting them twice
      let lookahead = idx + 1;
      while (lookahead < len && text[lookahead] === char) {
        lookahead += 1;
      }
      idx = lookahead;
      if (sentenceCount >= maxSentences) {
        break;
      }
      continue;
    }
    idx += 1;
  }

  if (sentenceCount === 0) {
    return formatForLog(text);
  }

  const snippet = text.slice(0, idx).trim();
  return snippet || formatForLog(text);
};

const logLLMEvent = ({ label, direction, text = '', metadata = {}, note }) => {
  const payload = {
    label,
    direction,
    length: typeof text === 'string' ? text.length : undefined,
    preview: formatForLog(text),
    preview_note: note,
    ...metadata,
  };
  console.log('[LLM TRACE]', payload);
};

const logLLMInput = (label, text, metadata) => {
  const preview = limitToSentences(text, DEFAULT_SENTENCE_PREVIEW_INPUT);
  logLLMEvent({
    label,
    direction: 'input',
    text: preview,
    metadata,
    note: `first ${DEFAULT_SENTENCE_PREVIEW_INPUT} sentences`,
  });
};

const logLLMOutput = (label, text, metadata) => {
  const preview = limitToSentences(text, DEFAULT_SENTENCE_PREVIEW_OUTPUT);
  logLLMEvent({
    label,
    direction: 'output',
    text: preview,
    metadata,
    note: `first ${DEFAULT_SENTENCE_PREVIEW_OUTPUT} sentences`,
  });
};

module.exports = {
  logLLMInput,
  logLLMOutput,
  formatForLog,
  limitToSentences,
};
