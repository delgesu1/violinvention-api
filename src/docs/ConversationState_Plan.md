# Master Implementation Plan: Conversation State for ViolinVention API

## Executive Summary
Implement a **brief + outline** system that maintains conversation context at fixed ~300 tokens per message, avoiding the token explosion of `previous_response_id` while preserving conversation continuity.

## Phase 1: Database Schema Updates

### 1.1 Add columns to messages table
```sql
ALTER TABLE messages
ADD COLUMN outline TEXT,           -- 100-token outline of assistant responses
ADD COLUMN is_initial BOOLEAN DEFAULT FALSE;

-- Add new table for conversation briefs
CREATE TABLE conversation_briefs (
  id SERIAL PRIMARY KEY,
  chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brief JSONB NOT NULL,
  token_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(chat_id)
);

CREATE INDEX idx_briefs_chat ON conversation_briefs(chat_id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_brief_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_brief_updated_at
  BEFORE UPDATE ON conversation_briefs
  FOR EACH ROW EXECUTE FUNCTION update_brief_timestamp();
```

## Phase 2: Core Brief Management Service

### 2.1 Create new file: `src/services/brief.service.js`

```javascript
const { supabase } = require('../config/supabase');

// Wire format for minimal tokens
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

// Approximate token counting (replace with tiktoken if available)
const approxTokens = (s) => Math.ceil(s.length / 4);

// Clamp utilities
const clampArr = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);
const clampStrTokens = (s, maxTok) => {
  if (!s || approxTokens(s) <= maxTok) return s;
  const targetLen = Math.max(1, maxTok * 4);
  return s.slice(0, targetLen).replace(/\s+\S*$/, ""); // Clean word boundary
};

const TOKEN_BUDGET = 200;

// Main brief update function with guaranteed termination
const updateBrief = (oldBrief, memoryCard) => {
  let updated = { ...oldBrief, ...memoryCard };

  // Per-field caps (violin-specific)
  updated.decisions = clampArr(updated.decisions, 5);
  updated.open_q = clampArr(updated.open_q, 4);
  updated.constraints = clampArr(updated.constraints, 3);
  updated.techniques = clampArr(updated.techniques, 6); // Track techniques learned
  updated.goal = clampStrTokens(updated.goal || "", 40);
  updated.lesson_context = clampStrTokens(updated.lesson_context || "", 30);

  // Deterministic drop order
  const dropOne = () => {
    if (updated.open_q?.length) { updated.open_q.shift(); return; }
    if (updated.constraints?.length) { updated.constraints.shift(); return; }
    if (updated.decisions?.length) { updated.decisions.shift(); return; }
    if (updated.techniques?.length > 3) { updated.techniques.shift(); return; }
    if (updated.goal?.length > 20) {
      updated.goal = clampStrTokens(updated.goal, 20);
      return;
    }
  };

  // Final token fit with guard
  let guard = 100;
  while (approxTokens(toWire(updated)) > TOKEN_BUDGET && guard-- > 0) {
    dropOne();
  }

  // Absolute hard stop
  if (approxTokens(toWire(updated)) > TOKEN_BUDGET) {
    // Nuclear option - use LONG keys (will be shortened in toWire)
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

// Get or create brief for chat
const getBrief = async (chat_id) => {
  const { data, error } = await supabase
    .from('conversation_briefs')
    .select('brief')
    .eq('chat_id', chat_id)
    .single();

  if (data) return data.brief;

  // Initialize new brief for new chats
  return {
    goal: "",
    constraints: [],
    decisions: [],
    open_q: [],
    techniques: [],
    lesson_context: ""
  };
};

// Save brief to database
const saveBrief = async (chat_id, user_id, brief) => {
  const tokenCount = approxTokens(toWire(brief));

  await supabase
    .from('conversation_briefs')
    .upsert({
      chat_id,
      user_id,
      brief,
      token_count: tokenCount,
      updated_at: new Date()
    });
};

// Generate outline from assistant response
const generateOutline = (assistantMessage) => {
  // Extract headings and key points (no API call needed)
  const lines = assistantMessage.split('\n');
  const outline = [];

  for (const line of lines) {
    // Capture headings (##, **, numbered lists, bullets)
    if (line.match(/^#{1,3}\s+(.+)/) ||
        line.match(/^\*\*(.+)\*\*/) ||
        line.match(/^\d+\.\s+(.+)/) ||
        line.match(/^\s*[-*]\s+(.+)/)) {
      outline.push(line.trim().substring(0, 50));
      if (outline.length >= 5) break; // Max 5 points
    }
  }

  // Fallback: if no structured content found, take first few lines
  if (outline.length === 0) {
    const nonEmptyLines = lines
      .filter(line => line.trim().length > 0 && line.length <= 80)
      .slice(0, 3);
    outline.push(...nonEmptyLines.map(line => line.substring(0, 50)));
  }

  return outline.join(' | ').substring(0, 400); // ~100 tokens
};

module.exports = {
  getBrief,
  saveBrief,
  updateBrief,
  toWire,
  generateOutline
};
```

## Phase 3: Update Message Service

### 3.1 Modify `src/services/message.service.js`

```javascript
const { getBrief, saveBrief, updateBrief, toWire, generateOutline, approxTokens } = require('./brief.service');

// Function tool for reliable memory card updates (better than regex)
const memoryUpdateTool = {
  type: "function",
  function: {
    name: "update_memory",
    description: "Update conversation memory with key information",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Main objective (1 sentence max)" },
        decisions: { type: "array", items: { type: "string" }, description: "Key decisions made" },
        open_q: { type: "array", items: { type: "string" }, description: "Open questions" },
        techniques: { type: "array", items: { type: "string" }, description: "Violin techniques discussed" },
        lesson_context: { type: "string", description: "Current lesson focus area" }
      }
    }
  }
};

// Alternative: Sentinel-based approach (more reliable than regex)
const MEMORY_INSTRUCTION = `
At the end of your response, update conversation memory using this exact format:
<MEMORY_CARD>{"goal":"Master vibrato technique","decisions":["Practice 10 min daily"],"open_q":["Speed vs accuracy?"],"techniques":["vibrato"],"lesson_context":"intermediate vibrato"}</MEMORY_CARD>
Keep the JSON under 120 tokens total.`;

const sendMessage = async ({ message, chat_id, instruction_token, lesson_context, user, req, res }) => {
  res.writeHead(200, { "Content-type": "text/plain" });

  const abortController = new AbortController();
  let responseEnded = false;
  let assistantMessage = '';
  let responseId = null;

  // ... existing abort handlers ...

  try {
    // Verify chat ownership (existing code)
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('*')
      .eq('chat_id', chat_id)
      .eq('user_id', user.id)
      .single();

    if (chatError || !chat) {
      throw new ApiError(402, "Invalid Chat!");
    }

    // GET CONVERSATION CONTEXT
    const brief = await getBrief(chat_id);
    const wireBrief = toWire(brief);

    // Get last assistant message outline
    const { data: lastMessage } = await supabase
      .from('messages')
      .select('outline')
      .eq('chat_id', chat_id)
      .eq('role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const lastOutline = lastMessage?.outline || "";

    // BUILD INPUT WITH CONTEXT
    const userMessageContent = `${message} ${instruction_token}`;

    // Construct conversation-aware input
    const contextualInput = [
      wireBrief && `Conversation context: ${wireBrief}`,
      lastOutline && `Previous response outline: ${lastOutline}`,
      userMessageContent,
      MEMORY_INSTRUCTION
    ].filter(Boolean).join('\n\n');

    console.log('[Conversation Context] Brief tokens:', approxTokens(wireBrief));
    console.log('[Conversation Context] Outline tokens:', approxTokens(lastOutline));

    // Save user message (existing code)
    const { data: userMsg } = await supabase
      .from('messages')
      .insert({
        role: 'user',
        content: message, // Clean message without instruction
        chat_id,
        user_id: user.id,
        lesson_context: lesson_context || null,
      })
      .select()
      .single();

    // Call OpenAI with context (NO previous_response_id!)
    // Option 1: With function tool (most reliable)
    const responseStream = await openaiClient.responses.create({
      prompt: {
        id: PROMPT_ID,
        version: PROMPT_VERSION
      },
      input: contextualInput,
      tools: [memoryUpdateTool], // Add memory update tool
      store: false, // We manage our own state
      stream: true,
      ...(lesson_context && {
        metadata: {
          lesson_context: JSON.stringify(lesson_context)
        }
      })
    });

    // Option 2: With sentinel parsing (simpler)
    /*
    const responseStream = await openaiClient.responses.create({
      prompt: {
        id: PROMPT_ID,
        version: PROMPT_VERSION
      },
      input: contextualInput,
      store: false,
      stream: true,
      ...(lesson_context && {
        metadata: {
          lesson_context: JSON.stringify(lesson_context)
        }
      })
    });
    */

    // Process streaming response (existing code)
    let isFirstEvent = true;
    for await (const event of responseStream) {
      if (res.writableEnded || abortController.signal.aborted) break;

      if (isFirstEvent) {
        console.log('[OpenAI API] First response event received');
        isFirstEvent = false;
      }

      const eventData = formatResponseEventForFrontend(event);
      if (eventData) {
        res.write(eventData);

        // Accumulate assistant message
        const eventType = event.type || event.event;
        if (eventType?.includes('delta')) {
          assistantMessage += event.delta || event.text || event.content || '';
        } else if (eventType?.includes('created')) {
          responseId = event.response?.id || event.id;
        }
      }
    }

  } catch (error) {
    console.error("Error in sendMessage:", error);
    // ... existing error handling ...
  } finally {
    // SAVE MESSAGE AND UPDATE BRIEF
    if (assistantMessage && !abortController.signal.aborted) {
      try {
        let outline = "";

        // Option 1: Extract memory from function tool calls (if using tools)
        // TODO: Handle tool call events from streaming response

        // Option 2: Extract MEMORY_CARD with sentinel parsing (more reliable)
        const memoryMatch = assistantMessage.match(/<MEMORY_CARD>([\s\S]*?)<\/MEMORY_CARD>/);

        if (memoryMatch) {
          try {
            const memoryCard = JSON.parse(memoryMatch[1].trim());
            const updatedBrief = updateBrief(brief, memoryCard);
            await saveBrief(chat_id, user.id, updatedBrief);
            console.log('[Brief Updated] New token count:', approxTokens(toWire(updatedBrief)));

            // Remove MEMORY_CARD from displayed message
            assistantMessage = assistantMessage.replace(/<MEMORY_CARD>[\s\S]*?<\/MEMORY_CARD>/, '').trim();
          } catch (parseError) {
            console.error('[MEMORY_CARD] Parse error, keeping previous brief:', parseError);
          }
        }

        // Generate outline for next turn
        outline = generateOutline(assistantMessage);

        // Save assistant message with outline
        await supabase
          .from('messages')
          .insert({
            role: 'assistant',
            content: assistantMessage,
            outline: outline,
            chat_id,
            user_id: user.id,
            response_id: responseId,
          });

      } catch (dbError) {
        console.error("Error saving assistant message:", dbError);
      }
    }

    if (!responseEnded && !res.writableEnded) {
      responseEnded = true;
      res.end();
    }
  }
};

// Similar updates for sendFirstMessage...
const sendFirstMessage = async ({ message, instruction_token, lesson_context, user, req, res }) => {
  // ... existing setup ...

  // Initialize brief for first message
  const initialBrief = {
    goal: "",
    constraints: [],
    decisions: [],
    open_q: [],
    techniques: [],
    lesson_context: lesson_context?.type || ""
  };

  // Build input with MEMORY_INSTRUCTION
  const contextualInput = [
    `${message} ${instruction_token}`,
    MEMORY_INSTRUCTION
  ].join('\n\n');

  // ... rest follows same pattern as sendMessage ...
};
```

## Phase 4: Testing & Rollout Strategy

### 4.1 Test Scenarios
1. **New conversation** - Verify brief initialization
2. **Long conversation** - Ensure brief stays under 200 tokens
3. **MEMORY_CARD parsing** - Test malformed JSON handling
4. **Outline generation** - Verify extraction quality
5. **Token counting** - Confirm stays under budget

### 4.2 Gradual Rollout
```javascript
// Feature flag for testing
const USE_CONVERSATION_CONTEXT = process.env.ENABLE_CONTEXT === 'true';

if (USE_CONVERSATION_CONTEXT) {
  // New context system
  const brief = await getBrief(chat_id);
  // ...
} else {
  // Existing system
  const responseStream = await openaiClient.responses.create({
    input: userMessageContent,
    // ...
  });
}
```

## Phase 5: Monitoring & Optimization

### 5.1 Add metrics tracking
```javascript
const trackContextUsage = async (chat_id, briefTokens, outlineTokens) => {
  await supabase
    .from('context_metrics')
    .insert({
      chat_id,
      brief_tokens: briefTokens,
      outline_tokens: outlineTokens,
      total_context: briefTokens + outlineTokens,
      timestamp: new Date()
    });
};
```

### 5.2 Future Enhancements (Only When Needed)
- **Week 4**: If users reference old content frequently, add retrieval
- **Week 8**: If MEMORY_CARD fails >5%, add validator
- **Month 3**: If conversations get complex, add topic segmentation

## Cost Analysis

**Per message with this system (CORRECTED):**
- System prompt (cached): ~500 tokens (discounted after first use)
- Brief (wire format): ~200 tokens
- Outline: ~100 tokens
- User message: ~100 tokens (varies)
- MEMORY instruction: ~80 tokens
- **Total input: ~980 tokens** (not the 19,000 mentioned earlier!)

**Cost per message: $0.00123** (GPT-5: 980 × $1.25/M) + $0.02 (output: 2000 × $10/M) = **$0.02123**

**At message 20:**
- This system: $0.02123
- previous_response_id: $0.52+
- **Savings: 96%**

**Note:** The original cost analysis incorrectly included "file search: 19,000 tokens" but our implementation doesn't send file search context at all - only brief + outline + user message.

## Critical Success Factors

1. **NO previous_response_id** - Will explode your costs
2. **NO JSON schema** - Use regex parsing for reliability
3. **NO embeddings initially** - Add only if needed
4. **Always enforce token limits** - Brief can't grow unbounded
5. **Test MEMORY_CARD parsing** - Must handle malformed JSON gracefully

This approach gives you conversation continuity at fixed, predictable costs while working seamlessly with your existing Responses API streaming implementation.