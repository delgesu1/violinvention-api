const { supabase } = require('../config/supabase');

/**
 * Brief Service - Manages conversation context briefs
 * Uses a "brief + outline" system to maintain conversation context
 * at fixed token cost instead of exponentially growing with previous_response_id
 */

// Wire format for minimal token usage
// Converts long field names to short keys to save tokens
const toWire = (brief) => {
  const w = {
    g: brief.goal || "",           // goal -> g
    c: brief.constraints || [],    // constraints -> c
    d: brief.decisions || [],      // decisions -> d
    oq: brief.open_q || [],        // open_questions -> oq
    t: brief.techniques || [],     // violin techniques covered
    lc: brief.lesson_context || "" // current lesson focus
  };
  return JSON.stringify(w);
};

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

/**
 * Update brief with new memory card information
 * Implements guaranteed termination and deterministic shrinking
 * @param {Object} oldBrief - Existing brief object
 * @param {Object} memoryCard - New information from AI response
 * @returns {Object} Updated brief within token budget
 */
const updateBrief = (oldBrief, memoryCard) => {
  // Start with merged data
  let updated = { ...oldBrief, ...memoryCard };

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
  if (approxTokens(toWire(updated)) > TOKEN_BUDGET) {
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

  return updated;
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
      return data.brief;
    }

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('[getBrief] Database error:', error);
    }
  } catch (err) {
    console.error('[getBrief] Unexpected error:', err);
  }

  // Return default brief structure for new chats
  return {
    goal: "",
    constraints: [],
    decisions: [],
    open_q: [],
    techniques: [],
    lesson_context: ""
  };
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