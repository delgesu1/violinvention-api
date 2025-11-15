const MAX_LOG_CHARS = 2000;

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

const logLLMEvent = ({ label, direction, text = '', metadata = {} }) => {
  const payload = {
    label,
    direction,
    length: typeof text === 'string' ? text.length : undefined,
    preview: formatForLog(text),
    ...metadata,
  };
  console.log('[LLM TRACE]', payload);
};

const logLLMInput = (label, text, metadata) => {
  logLLMEvent({ label, direction: 'input', text, metadata });
};

const logLLMOutput = (label, text, metadata) => {
  logLLMEvent({ label, direction: 'output', text, metadata });
};

module.exports = {
  logLLMInput,
  logLLMOutput,
  formatForLog,
};
