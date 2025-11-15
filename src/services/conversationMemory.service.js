const { supabase } = require('../config/supabase');
const config = require('../config/config');
const { openaiClient } = require('../config/openai');
const { logLLMInput, logLLMOutput } = require('../utils/llmLogger');

const memoryConfig = config.memory || {};

const DEFAULT_MEMORY_STATE = {
  global_summary: "",
  last_summarized_message_id: null,
};

const summarizerPromptRef = memoryConfig.globalSummaryPromptId
  ? {
      id: memoryConfig.globalSummaryPromptId,
      version: memoryConfig.globalSummaryPromptVersion,
    }
  : null;

const summarizationLocks = new Set();

const approxTokens = (value) => {
  if (typeof value !== 'string') {
    return 0;
  }
  return Math.ceil(value.length / 4);
};

const clampTextToTokenCount = (text, maxTokens) => {
  if (!text || !maxTokens || approxTokens(text) <= maxTokens) {
    return text || "";
  }

  const targetLength = Math.max(8, maxTokens * 4);
  const sliced = text.slice(0, targetLength);
  return sliced.replace(/\s+\S*$/, '').trim();
};

const formatLegacyList = (label, list) => {
  if (!Array.isArray(list) || list.length === 0) {
    return "";
  }
  return `${label}: ${list.filter(Boolean).join(' | ')}`;
};

const formatLegacyText = (label, value) => {
  if (!value || typeof value !== 'string') {
    return "";
  }
  return `${label}: ${value}`;
};

const formatLegacySummary = (summary = {}) => {
  if (!summary || typeof summary !== 'object') {
    return "";
  }

  const lines = [
    formatLegacyText('Goal', summary.goal || summary.g),
    formatLegacyList('Constraints', summary.constraints || summary.c),
    formatLegacyList('Decisions', summary.decisions || summary.d),
    formatLegacyList('Open questions', summary.open_q || summary.oq),
    formatLegacyList('Techniques', summary.techniques || summary.t),
    formatLegacyText('Lesson context', summary.lesson_context || summary.lc),
  ].filter(Boolean);

  return lines.join('\n');
};

const formatLegacyMemoryCards = (cards = []) => {
  if (!Array.isArray(cards) || cards.length === 0) {
    return "";
  }

  const sections = cards
    .filter((card) => card && typeof card === 'object')
    .map((card, index) => {
      const header = `Memory card ${index + 1}`;
      const body = formatLegacySummary(card);
      return body ? `${header}:\n${body}` : "";
    })
    .filter(Boolean);

  return sections.join('\n\n');
};

const normalizeMemoryState = (raw) => {
  if (!raw) {
    return { ...DEFAULT_MEMORY_STATE };
  }

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[conversationMemory] Failed to parse brief JSON string', err);
      return { ...DEFAULT_MEMORY_STATE };
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_MEMORY_STATE };
  }

  const normalized = {
    global_summary: typeof parsed.global_summary === 'string' ? parsed.global_summary : "",
    last_summarized_message_id: parsed.last_summarized_message_id || parsed.lastSummarizedMessageId || null,
  };

  if (!normalized.global_summary) {
    const legacySummary = formatLegacySummary(parsed.summary || parsed.s);
    const legacyCards = formatLegacyMemoryCards(parsed.memory_cards || parsed.mc);
    normalized.global_summary = [legacySummary, legacyCards].filter(Boolean).join('\n\n').trim();
  }

  if (!normalized.global_summary) {
    normalized.global_summary = "";
  }

  if (typeof normalized.last_summarized_message_id === 'number') {
    normalized.last_summarized_message_id = String(normalized.last_summarized_message_id);
  }

  return normalized;
};

const getConversationMemory = async (chatId) => {
  if (!chatId) {
    return { ...DEFAULT_MEMORY_STATE };
  }

  try {
    const { data, error } = await supabase
      .from('conversation_briefs')
      .select('brief')
      .eq('chat_id', chatId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[conversationMemory] Failed to load brief', { chat_id: chatId, error });
    }

    if (data && data.brief) {
      return normalizeMemoryState(data.brief);
    }
  } catch (err) {
    console.error('[conversationMemory] Unexpected error loading brief', err);
  }

  return { ...DEFAULT_MEMORY_STATE };
};

const saveConversationMemory = async (chatId, userId, brief) => {
  const normalized = normalizeMemoryState(brief);
  const tokenCount = approxTokens(normalized.global_summary || "");

  try {
    const { error } = await supabase
      .from('conversation_briefs')
      .upsert(
        {
          chat_id: chatId,
          user_id: userId,
          brief: normalized,
          token_count: tokenCount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'chat_id' }
      );

    if (error) {
      console.error('[conversationMemory] Failed to save brief', { chat_id: chatId, error });
      throw error;
    }

    console.log(`[conversationMemory] Saved brief for chat ${chatId}, tokens: ${tokenCount}`);
  } catch (err) {
    console.error('[conversationMemory] Unexpected error saving brief', err);
    throw err;
  }

  return normalized;
};

const getMemoryKnobs = (overrides = {}) => ({
  kRawTurns: overrides.kRawTurns || memoryConfig.kRawTurns || 3,
  summaryTokenCap: overrides.summaryTokenCap || memoryConfig.summaryTokenCap || 500,
  promptTokenBudget: overrides.promptTokenBudget || memoryConfig.promptTokenBudget || 3000,
  chunkSummarizeThreshold: overrides.chunkSummarizeThreshold || memoryConfig.chunkSummarizeThreshold || 6000,
});

const fetchCursorTimestamp = async (chatId, userId, messageId) => {
  if (!messageId) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('created_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .eq('message_id', messageId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[conversationMemory] Failed to load cursor message timestamp', { chat_id: chatId, message_id: messageId, error });
    }

    return data?.created_at || null;
  } catch (err) {
    console.error('[conversationMemory] Unexpected error getting cursor timestamp', err);
    return null;
  }
};

const fetchMessagesAfterCursor = async (chatId, userId, lastMessageId, { excludeMessageIds } = {}) => {
  const excludeSet = new Set((excludeMessageIds || []).filter(Boolean));
  const cursorTimestamp = await fetchCursorTimestamp(chatId, userId, lastMessageId);

  try {
    let query = supabase
      .from('messages')
      .select('message_id, role, content, metadata, created_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true });

    if (cursorTimestamp) {
      query = query.gt('created_at', cursorTimestamp);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[conversationMemory] Failed to fetch chunk buffer messages', { chat_id: chatId, error });
      return [];
    }

    return (data || []).filter((row) => !excludeSet.has(row.message_id));
  } catch (err) {
    console.error('[conversationMemory] Unexpected error fetching messages', err);
    return [];
  }
};

const groupMessagesIntoTurns = (messages = []) => {
  const turns = [];
  let pendingUser = null;

  for (const message of messages) {
    if (message.role === 'user') {
      if (pendingUser) {
        turns.push({ user: pendingUser, assistant: null });
      }
      pendingUser = message;
    } else if (message.role === 'assistant') {
      if (!pendingUser) {
        turns.push({ user: null, assistant: message });
      } else {
        turns.push({ user: pendingUser, assistant: message });
        pendingUser = null;
      }
    }
  }

  if (pendingUser) {
    turns.push({ user: pendingUser, assistant: null });
  }

  return turns;
};

const formatTurnForPrompt = (turn, { includeHeading = false, index = 0 } = {}) => {
  const lines = [];
  if (includeHeading) {
    lines.push(`Turn ${index + 1}:`);
  }

  const cleanUser = typeof turn?.user?.content === 'string' && turn.user.content.trim().length > 0
    ? turn.user.content
    : null;
  const cleanAssistant = typeof turn?.assistant?.content === 'string' && turn.assistant.content.trim().length > 0
    ? turn.assistant.content
    : null;

  if (cleanUser) {
    lines.push(`User: ${cleanUser}`);
  }

  if (cleanAssistant) {
    const metadata = turn?.assistant?.metadata || {};
    const variant = metadata.model_variant || metadata.modelVariant || null;
    const label = variant ? `Assistant (${variant})` : 'Assistant';
    lines.push(`${label}: ${cleanAssistant}`);
  }

  if (!cleanUser && !cleanAssistant) {
    lines.push('User: [no content captured]');
    lines.push('Assistant: [no content captured]');
  }

  return lines.join('\n');
};

const formatTurnsBlock = (turns, { includeHeadings = false } = {}) => {
  return turns
    .map((turn, idx) => formatTurnForPrompt(turn, { includeHeading: includeHeadings, index: idx }))
    .join('\n\n');
};

const composeMemoryBlock = (summary, tailTurns) => {
  const sections = [];
  if (summary) {
    sections.push(`BACKGROUND – PRIOR CONVERSATION SUMMARY (use only if relevant):\n${summary}`.trim());
  }

  if (Array.isArray(tailTurns) && tailTurns.length) {
    sections.push(`RECENT RAW TURNS:\n${formatTurnsBlock(tailTurns)}`.trim());
  }

  return sections.join('\n\n').trim();
};

const calculateTurnTokenCount = (turns = []) => {
  return turns.reduce((acc, turn) => {
    return acc + approxTokens(turn?.user?.content || "") + approxTokens(turn?.assistant?.content || "");
  }, 0);
};

const getLastAssistantMessageId = (turns = []) => {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const id = turns[i]?.assistant?.message_id;
    if (id) {
      return id;
    }
  }
  return null;
};

const formatSummarizerInput = (existingSummary, turns) => {
  const summarySection = existingSummary && existingSummary.trim().length > 0 ? existingSummary.trim() : 'NONE';
  const turnsSection = turns
    .map((turn, idx) => {
      const userText = turn?.user?.content?.trim() || '[No user message recorded]';
      const assistantText = turn?.assistant?.content?.trim() || '[No assistant reply recorded]';
      return `Turn ${idx + 1}:\nUser: ${userText}\nAssistant: ${assistantText}`;
    })
    .join('\n\n');

  return `=== EXISTING_SUMMARY ===\n${summarySection}\n=== END_EXISTING_SUMMARY ===\n\n=== NEW_TURNS ===\n${turnsSection}\n=== END_NEW_TURNS ===`;
};

const extractResponseText = (response) => {
  if (!response) {
    return "";
  }

  if (typeof response.output_text === 'string') {
    return response.output_text.trim();
  }

  if (Array.isArray(response.output_text)) {
    const joined = response.output_text.join('\n').trim();
    if (joined) {
      return joined;
    }
  }

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (Array.isArray(item?.content)) {
        for (const chunk of item.content) {
          if (typeof chunk?.text === 'string' && chunk.text.trim()) {
            return chunk.text.trim();
          }
          if (typeof chunk?.value === 'string' && chunk.value.trim()) {
            return chunk.value.trim();
          }
        }
      }
    }
  }

  return "";
};

const loadTurnsSinceSummary = async ({ chatId, userId, lastSummarizedMessageId, excludeMessageIds = [] }) => {
  const messages = await fetchMessagesAfterCursor(chatId, userId, lastSummarizedMessageId, { excludeMessageIds });
  return groupMessagesIntoTurns(messages);
};

const buildMemoryContext = async ({ chatId, userId, excludeMessageIds = [], overrides = {} }) => {
  const knobs = getMemoryKnobs(overrides);
  const brief = await getConversationMemory(chatId);
  const turns = await loadTurnsSinceSummary({
    chatId,
    userId,
    lastSummarizedMessageId: brief.last_summarized_message_id,
    excludeMessageIds,
  });

  const initialSummary = clampTextToTokenCount(brief.global_summary || "", knobs.summaryTokenCap);
  let summaryForPrompt = initialSummary;
  let tailTurns = turns.slice(-knobs.kRawTurns);
  let droppedTailTurns = 0;

  const recomputeMemoryBlock = () => composeMemoryBlock(summaryForPrompt, tailTurns);
  let memoryText = recomputeMemoryBlock();

  while (approxTokens(memoryText) > knobs.promptTokenBudget && tailTurns.length > 1) {
    tailTurns = tailTurns.slice(1);
    droppedTailTurns += 1;
    memoryText = recomputeMemoryBlock();
  }

  if (approxTokens(memoryText) > knobs.promptTokenBudget && summaryForPrompt) {
    const tailOnlyBlock = composeMemoryBlock("", tailTurns);
    const remainingTokens = Math.max(0, knobs.promptTokenBudget - approxTokens(tailOnlyBlock));
    const targetSummaryTokens = remainingTokens ? Math.min(knobs.summaryTokenCap, remainingTokens) : 0;
    summaryForPrompt = clampTextToTokenCount(summaryForPrompt, targetSummaryTokens);
    memoryText = composeMemoryBlock(summaryForPrompt, tailTurns);
  }

  return {
    brief,
    turns,
    tailTurns,
    memoryText,
    summaryText: summaryForPrompt,
    droppedTailTurns,
    summaryWasTruncated: summaryForPrompt !== initialSummary,
    chunkTokenCount: calculateTurnTokenCount(turns),
  };
};

const maybeUpdateGlobalSummary = async ({ chatId, userId, brief, overrides = {}, turns: providedTurns }) => {
  if (!brief) {
    return { summarized: false, reason: 'missing_brief' };
  }

  if (summarizationLocks.has(chatId)) {
    return { summarized: false, reason: 'in_flight' };
  }

  summarizationLocks.add(chatId);
  try {
    const knobs = getMemoryKnobs(overrides);
    const turns = Array.isArray(providedTurns)
      ? providedTurns
      : await loadTurnsSinceSummary({ chatId, userId, lastSummarizedMessageId: brief.last_summarized_message_id });

    const chunkTokens = calculateTurnTokenCount(turns);
    const totalTokens = chunkTokens + approxTokens(brief.global_summary || "");

    if (totalTokens <= knobs.chunkSummarizeThreshold || turns.length <= knobs.kRawTurns) {
      return {
        summarized: false,
        reason: 'below_threshold',
        totalTokens,
        chunkTokens,
      };
    }

    const tail = turns.slice(-knobs.kRawTurns);
    const olderPart = turns.slice(0, -knobs.kRawTurns);

    if (!olderPart.length) {
      return { summarized: false, reason: 'no_older_turns' };
    }

    const newSummaryInput = formatSummarizerInput(brief.global_summary || "NONE", olderPart);
    logLLMInput('memory.summarizer', newSummaryInput, {
      chat_id: chatId,
      turns: olderPart.length,
      prompt_id: summarizerPromptRef.id,
      prompt_version: summarizerPromptRef.version,
    });

    if (!summarizerPromptRef?.id) {
      console.warn('[conversationMemory] Missing summarizer prompt configuration');
      return { summarized: false, reason: 'missing_prompt' };
    }

    let responseText = "";
    try {
      const response = await openaiClient.responses.create({
        prompt: summarizerPromptRef,
        input: newSummaryInput,
        stream: false,
        metadata: {
          intent: 'conversation_memory_summary',
          chat_id: chatId,
          turns_compressed: String(olderPart.length),
        },
      });
      responseText = extractResponseText(response);
    } catch (error) {
      console.error('[conversationMemory] Summarization request failed', {
        chat_id: chatId,
        message: error.message,
      });
      return { summarized: false, reason: 'openai_error', error };
    }

    if (!responseText) {
      console.warn('[conversationMemory] Summarizer returned empty summary');
      return { summarized: false, reason: 'empty_summary' };
    }

    logLLMOutput('memory.summarizer', responseText, {
      chat_id: chatId,
      turns: olderPart.length,
    });

    const trimmedSummary = clampTextToTokenCount(responseText, knobs.summaryTokenCap);
    const newCursor = getLastAssistantMessageId(olderPart) || brief.last_summarized_message_id;

    if (!newCursor) {
      console.warn('[conversationMemory] Unable to determine new cursor after summarization');
      return { summarized: false, reason: 'missing_cursor' };
    }

    const updatedBrief = {
      global_summary: trimmedSummary,
      last_summarized_message_id: newCursor,
    };

    await saveConversationMemory(chatId, userId, updatedBrief);

    console.log('[conversationMemory] Summarized chunk', {
      chat_id: chatId,
      turnsCompressed: olderPart.length,
      totalTokens,
      newCursor,
    });

    return {
      summarized: true,
      brief: updatedBrief,
      tailRetained: tail.length,
      totalTokens,
      chunkTokens,
    };
  } finally {
    summarizationLocks.delete(chatId);
  }
};

module.exports = {
  DEFAULT_MEMORY_STATE,
  approxTokens,
  normalizeMemoryState,
  getConversationMemory,
  saveConversationMemory,
  clampTextToTokenCount,
  buildMemoryContext,
  maybeUpdateGlobalSummary,
};
