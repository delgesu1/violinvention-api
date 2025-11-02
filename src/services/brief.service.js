const { supabase } = require('../config/supabase');

/**
 * Brief Service - Manages conversation context briefs
 * Uses a "brief + outline" system to maintain conversation context
 * at fixed token cost instead of exponentially growing with previous_response_id
 */

// Approximate token counting (can replace with tiktoken later if needed)
// Uses 4 chars per token heuristic which is accurate enough for budget control
const approxTokens = (s) => {
  if (typeof s !== 'string') return 0;
  return Math.ceil(s.length / 4);
};

// Detect if an outline contains substantial content
const isContentfulOutline = (outline) => {
  if (!outline || typeof outline !== 'string') return false;

  const tokens = approxTokens(outline);
  const hasNumberedItems = (outline.match(/\b\d+\.\s/g) || []).length >= 3;
  const hasBullets = (outline.match(/^\s*[-*]\s+/gm) || []).length >= 3;
  const hasHeaders = (outline.match(/^#{1,3}\s+/gm) || []).length >= 2;

  return tokens >= 60 || hasNumberedItems || hasBullets || hasHeaders;
};

// Utility functions for array and string clamping
const clampArr = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);

const clampStrTokens = (s, maxTok) => {
  if (!s || approxTokens(s) <= maxTok) return s;
  const targetLen = Math.max(1, maxTok * 4);
  // Clean word boundary truncation
  return s.slice(0, targetLen).replace(/\s+\S*$/, "");
};

// Token budget for briefs - keeps context manageable
const TOKEN_BUDGET = 200;

const DEFAULT_SUMMARY = {
  goal: "",
  constraints: [],
  decisions: [],
  open_q: [],
  techniques: [],
  lesson_context: "",
};

const DEFAULT_BRIEF = {
  summary: { ...DEFAULT_SUMMARY },
  memory_cards: [],
  initial_outline: "",
};

const normalizeSummary = (raw = {}) => {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_SUMMARY };
  }

  return {
    goal: raw.goal || "",
    constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    open_q: Array.isArray(raw.open_q) ? raw.open_q : [],
    techniques: Array.isArray(raw.techniques) ? raw.techniques : [],
    lesson_context: raw.lesson_context || "",
  };
};

const normalizeBrief = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_BRIEF, summary: { ...DEFAULT_SUMMARY } };
  }

  // Backward compatibility: old briefs stored summary fields at root level
  const hasLegacyShape = ['goal', 'constraints', 'decisions', 'open_q', 'techniques', 'lesson_context'].some(
    (key) => Object.prototype.hasOwnProperty.call(raw, key)
  );

  const summary = hasLegacyShape ? normalizeSummary(raw) : normalizeSummary(raw.summary);

  const memoryCards = Array.isArray(raw.memory_cards)
    ? clampArr(raw.memory_cards.filter((card) => card && typeof card === 'object'), 6)
    : [];

  const initialOutline = typeof raw.initial_outline === 'string' ? raw.initial_outline : "";

  return {
    summary,
    memory_cards: memoryCards,
    initial_outline: initialOutline,
  };
};

const toWireSummary = (summary) => {
  const norm = normalizeSummary(summary);
  return {
    g: norm.goal || "",
    c: norm.constraints || [],
    d: norm.decisions || [],
    oq: norm.open_q || [],
    t: norm.techniques || [],
    lc: norm.lesson_context || "",
  };
};

const toWireMemoryCard = (card = {}) => ({
  g: card.goal || "",
  c: Array.isArray(card.constraints) ? card.constraints : [],
  d: Array.isArray(card.decisions) ? card.decisions : [],
  oq: Array.isArray(card.open_q) ? card.open_q : [],
  t: Array.isArray(card.techniques) ? card.techniques : [],
  lc: card.lesson_context || "",
});

const toWire = (brief) => {
  const normalized = normalizeBrief(brief);
  return JSON.stringify({
    s: toWireSummary(normalized.summary),
    mc: normalized.memory_cards.map(toWireMemoryCard),
  });
};

/**
 * Update brief with new memory card information while keeping recent history.
 * Implements guaranteed termination and deterministic shrinking
 * @param {Object} oldBrief - Existing brief object
 * @param {Object} memoryCard - New information from AI response
 * @returns {Object} Updated brief within token budget
 */
const updateBrief = (oldBrief, memoryCard) => {
  const normalized = normalizeBrief(oldBrief);

  const summary = normalizeSummary(normalized.summary);

  const mergedCard = memoryCard && typeof memoryCard === 'object' ? memoryCard : {};
  let updated = { ...summary, ...mergedCard };

  // Apply per-field caps first (prevents most overflows)
  // Violin-specific field limits based on typical usage
  updated.decisions = clampArr(updated.decisions, 5);
  updated.open_q = clampArr(updated.open_q, 4);
  updated.constraints = clampArr(updated.constraints, 3);
  updated.techniques = clampArr(updated.techniques, 6); // Track techniques learned
  updated.goal = clampStrTokens(updated.goal || "", 40);
  updated.lesson_context = clampStrTokens(updated.lesson_context || "", 30);

  // Deterministic drop order (least important first)
  const dropOne = () => {
    // Remove oldest items from arrays first
    if (updated.open_q?.length) { updated.open_q.shift(); return; }
    if (updated.constraints?.length) { updated.constraints.shift(); return; }
    if (updated.decisions?.length) { updated.decisions.shift(); return; }
    if (updated.techniques?.length > 3) { updated.techniques.shift(); return; }

    // Then shrink strings if arrays are minimal
    if (updated.goal?.length > 20) {
      updated.goal = clampStrTokens(updated.goal, 20);
      return;
    }
  };

  // Final token fit with guaranteed termination
  let guard = 100; // Prevents infinite loops
  while (approxTokens(toWire(updated)) > TOKEN_BUDGET && guard-- > 0) {
    dropOne();
  }

  // Absolute hard stop - nuclear option with correct key format
  if (approxTokens(JSON.stringify(toWireSummary(updated))) > TOKEN_BUDGET) {
    // Use LONG keys (will be shortened in toWire)
    updated = {
      goal: "Conversation",
      decisions: [],
      open_q: [],
      constraints: [],
      techniques: [],
      lesson_context: ""
    };
  }

  const updatedCards = clampArr([...normalized.memory_cards, mergedCard], 6);

  return {
    summary: updated,
    memory_cards: updatedCards,
    initial_outline: normalized.initial_outline,
  };
};

/**
 * Get existing brief for a chat, or return default structure for new chats
 * @param {string} chat_id - Chat UUID
 * @returns {Object} Brief object
 */
const getBrief = async (chat_id) => {
  try {
    const { data, error } = await supabase
      .from('conversation_briefs')
      .select('brief')
      .eq('chat_id', chat_id)
      .single();

    if (data && data.brief) {
      return normalizeBrief(data.brief);
    }

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[getBrief] Database error:', error);
    }
  } catch (err) {
    console.error('[getBrief] Unexpected error:', err);
  }

  // Return default brief structure for new chats
  return { ...DEFAULT_BRIEF, summary: { ...DEFAULT_SUMMARY } };
};

/**
 * Save brief to database with upsert (insert or update)
 * @param {string} chat_id - Chat UUID
 * @param {string} user_id - User UUID
 * @param {Object} brief - Brief object to save
 */
const saveBrief = async (chat_id, user_id, brief) => {
  try {
    const tokenCount = approxTokens(toWire(brief));

    const { error } = await supabase
      .from('conversation_briefs')
      .upsert({
        chat_id,
        user_id,
        brief,
        token_count: tokenCount,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'chat_id' // Update if chat_id already exists
      });

    if (error) {
      console.error('[saveBrief] Database error:', error);
      throw error;
    }

    console.log(`[saveBrief] Saved brief for chat ${chat_id}, tokens: ${tokenCount}`);
  } catch (err) {
    console.error('[saveBrief] Unexpected error:', err);
    throw err;
  }
};

/**
 * Generate outline from assistant response for next turn context
 * Extracts headings, bullet points, and key structured content
 * @param {string} assistantMessage - Full assistant response
 * @returns {string} Compressed outline (~100 tokens)
 */
const generateOutline = (assistantMessage) => {
  if (!assistantMessage || typeof assistantMessage !== 'string') {
    return "";
  }

  // Extract headings and key points (no API call needed)
  const lines = assistantMessage.split('\n');
  const outline = [];

  for (const line of lines) {
    // Capture headings (##, **, numbered lists, bullets)
    if (line.match(/^#{1,3}\s+(.+)/) ||           // Markdown headers
        line.match(/^\*\*(.+)\*\*/) ||            // Bold text
        line.match(/^\d+\.\s+(.+)/) ||            // Numbered lists
        line.match(/^\s*[-*]\s+(.+)/)) {          // Bullet points
      outline.push(line.trim().substring(0, 50)); // Limit each item to 50 chars
      if (outline.length >= 5) break;             // Max 5 points
    }
  }

  // Fallback: if no structured content found, take first few lines
  if (outline.length === 0) {
    const nonEmptyLines = lines
      .filter(line => line.trim().length > 0 && line.length <= 80)
      .slice(0, 3);
    outline.push(...nonEmptyLines.map(line => line.substring(0, 50)));
  }

  // Join with separator and ensure total stays under ~100 tokens
  return outline.join(' | ').substring(0, 400); // ~100 tokens
};

module.exports = {
  getBrief,
  saveBrief,
  updateBrief,
  toWire,
  generateOutline,
  approxTokens, // Export for consistent token counting across services
  isContentfulOutline // Export for outline content detection
};
