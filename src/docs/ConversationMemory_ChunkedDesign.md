# Conversation Memory – Chunked Summary Design (v2)

## 1. Objectives

This document specifies a new conversation memory system that replaces the current MEMORY_CARD‑based approach with a simpler, more robust design built around:

- A **global summary** of older conversation history.
- A small **raw tail window** of the most recent turns.
- **Chunked summarization** using a cheap model (gpt‑5‑nano).
- Full support for multiple assistant models per chat (e.g. gpt‑5‑mini vs. gpt‑5.1 “deep dive”).

The design is intended to:

- Improve “felt” conversational memory (the assistant actually remembers meaningful past context).
- Avoid per‑turn summarization calls.
- Keep costs small relative to the main gpt‑5‑mini + RAG spend.
- Be easy to reason about and debug.

We do **not** define exact prompt wordings here; this is a behavioral and data‑flow spec.

---

## 2. High‑Level Behavior

On each turn:

1. The user sends a message (optionally with a different model selection, e.g. deep‑dive).
2. The backend calls the chosen assistant model (gpt‑5‑mini or gpt‑5.1 etc.) with:
   - A **global summary** of older history (if any).
   - A fixed number of **most recent raw turns** (user + assistant), K.
   - RAG context, instructions, etc. (existing behavior).
3. The assistant responds; the backend saves the raw messages to Supabase.
4. Periodically, when the accumulated raw history since the last summary becomes large enough, an asynchronous gpt‑5‑nano call **compresses the older part of the raw history** into the global summary.

Key properties:

- The last K turns are always included verbatim in the prompt (no summarization).
- Older turns are folded into the global summary in **chunks**, not every turn.
- Memory logic is **model‑agnostic**: it doesn’t care whether a turn came from mini or deep‑dive; it just sees text.

---

## 3. Core Concepts & Definitions

### 3.1 Turn

- A **turn** is one user message and its corresponding assistant reply:
  - `user_content`: raw user text.
  - `assistant_content`: raw assistant text.
  - `model_variant`: which model produced the assistant reply (e.g. `"arco"`, `"arco-pro"`, `"deep-dive"`).
  - `message_ids`: references to `messages` table rows for user/assistant.

The memory system operates over **turns**, not individual messages.

### 3.2 Global Summary

- A single text blob that summarizes **all history that is no longer in the raw tail window**.
- Lives in `conversation_briefs.brief` (see Data Model).
- Updated occasionally by gpt‑5‑nano.
- Target length: `SUMMARY_TOKEN_CAP ≈ 400–500` tokens (hard cap 500).

### 3.3 Chunk Buffer

- An in‑memory logical view of the **recent raw turns since the last global summary update**.
- Represented in storage by the existing `messages` table; in code we reconstruct:
  - `chunkBuffer = all turns with message_id > last_summarized_message_id` (see 4. Data Model).
- We **only ever show the last K turns from this buffer to the main model**, but the buffer itself may contain more turns until we decide to summarize.

### 3.4 Raw Tail Window (K)

- The number of most‑recent turns that are always included **verbatim** in the prompt.
- Fixed initial value: `K = 3`.
- For each prompt, we include:
  - `globalSummary` (if non‑empty).
  - The last K turns from `chunkBuffer` (user + assistant text).

### 3.5 Memory Token Limits

We use two budgets:

- `PROMPT_MEMORY_BUDGET` – max tokens we want to spend on memory **inside the gpt‑5‑mini/gpt‑5.1 prompt**:
  - Applies to: `globalSummary + last K turns`.
  - Initial target: `~2500–3000` tokens so memory stays a compact “background” relative to RAG.

- `CHUNK_SUMMARIZE_THRESHOLD` – higher threshold that decides **when** to update `globalSummary`:
  - Applies to: `globalSummary + ALL turns in chunkBuffer`.
  - Initial target: `~5000–6000` tokens.

We only call gpt‑5‑nano when `globalSummary + chunkBuffer` exceeds `CHUNK_SUMMARIZE_THRESHOLD`.

---

## 4. Data Model & Supabase

### 4.1 Existing Tables

We reuse:

- `chats`
- `messages`
- `conversation_briefs`

### 4.2 `conversation_briefs` structure (v2)

We will repurpose the existing `brief` JSON field to a v2 shape focused on the new memory system:

```jsonc
{
  "global_summary": "string (combined summary of older history)",
  "last_summarized_message_id": "uuid or null"
}
```

Notes:

- `last_summarized_message_id` is the **highest assistant message id** (or created_at cursor) whose content is guaranteed to be included in `global_summary`.
- `global_summary` is what we inject into prompts as “conversation so far”.
- Legacy MEMORY_CARD fields (`summary`, `memory_cards`, `initial_outline`) will be removed along with the old memory system; no migration of existing data is required in development.

### 4.3 Messages & Model Variants

We already store messages in `messages` with role `user` or `assistant`. To support multi‑model context:

- Ensure `messages.metadata` (or a new column) can store:
  - `model_variant` for assistant messages: `"arco"`, `"arco-pro"`, `"deep-dive"` (or whatever naming).
- This metadata is **not required** by the memory logic but useful for:
  - Debugging (“why did this answer look different?”),
  - Future features (“keep deep‑dive turns in tail longer”, etc.).

No core memory behavior depends on `model_variant`: all text is treated equally for summarization.

---

## 5. Runtime Algorithms

### 5.1 Building Memory Context for a Prompt

Used by both `sendFirstMessage` and `sendMessage` before calling gpt‑5‑mini / gpt‑5.1.

Steps:

1. **Load brief for this chat**
   - `brief = getBrief(chat_id)` → returns normalized object.
   - Extract:
     - `globalSummary = brief.global_summary || ""`
     - `lastSummarizedMessageId = brief.last_summarized_message_id || null`

2. **Fetch recent messages**
   - Query `messages` for this chat, ordered ascending by `created_at` or `id`:
     - All messages with `id > lastSummarizedMessageId` (if not null) → this is our logical `chunkBuffer`.
   - Group them into turns `(user, assistant)` in order.

3. **Determine raw tail**
   - Let `turns` be the ordered list of turns from `chunkBuffer`.
   - Raw tail for prompt: `tailTurns = last K turns of turns` (or fewer if < K).

4. **Build memory text**
   - Start with `memorySections = []`.
   - If `globalSummary` is non‑empty:
     - Push section like:
       - `"BACKGROUND – PRIOR CONVERSATION SUMMARY (use only if relevant):\n" + globalSummary`.
   - For each turn in `tailTurns` (from oldest to newest):
     - Append user and assistant text in a simple, consistent format, e.g.:
       - `User: <full user message>`
       - `Assistant: <full assistant reply>`
   - This memory block is intended for the model, not humans; clarity and consistency are more important than pretty formatting.

5. **Token budget enforcement (prompt)**
   - Estimate tokens for `memorySections.join("\n\n")`.
   - If this exceeds `PROMPT_MEMORY_BUDGET`:
     - First, reduce `tailTurns` count (drop the oldest tail turns) down to a minimum of 1–2 turns.
     - If still over budget, optionally truncate `globalSummary` with a simple heuristic (e.g. cut to last N characters) – this is a last‑resort safety valve.
   - Final `memoryText` is then prepended to the RAG context + instructions + current user message, with ordering like:
     - Background summary (if any)
     - Recent chat history (tail turns)
     - RAG / retrieved sources
     - Current user question and any high‑level instructions

6. **Call main model**
   - Use existing logic for sending requests to gpt‑5‑mini or deep‑dive model.
   - The memory layer is blind to which model is picked.

### 5.2 After Turn Completes – Chunked Summary Update

After saving the new user and assistant messages:

1. **Compute current chunk size**
   - Re‑compute `chunkBuffer` as in 5.1 step 2 (`messages` with `id > lastSummarizedMessageId`).
   - Estimate tokens for:
     - `globalSummary`, and
     - all turns in `chunkBuffer`.

2. **Check threshold**
   - If `tokens(globalSummary + chunkBuffer)` ≤ `CHUNK_SUMMARIZE_THRESHOLD`:
     - Do nothing; no nano call.
   - Else (too big) and there are more than K turns in `chunkBuffer`:
     - Proceed to summarization.

3. **Split into olderPart and tail**
   - Let `turns = ordered turns in chunkBuffer`.
   - `tail = last K turns of turns`.
   - `olderPart = all turns before tail` (may be several turns).
   - If `olderPart` is empty (e.g. very few turns), skip summarization; we’ll try again after more turns.

4. **Summarization call (gpt‑5‑nano)**
   - Build input text:
     - Use the hosted OpenAI prompt for global summaries. The backend will:
       - Set `prompt: { id: PROMPT_ID_SUMMARY_GLOBAL, version: PROMPT_VERSION_SUMMARY_GLOBAL }`, where:
         - `PROMPT_ID_SUMMARY_GLOBAL = 'pmpt_6917ebe9367c819396fe4840cf0f0e050c18a965a3366120'`.
         - `PROMPT_VERSION_SUMMARY_GLOBAL` is configured in env alongside other prompt versions.
       - Provide a single `input` string in this exact format:

         ```text
         === EXISTING_SUMMARY ===
         <existing summary text, or the word NONE if no summary yet>
         === END_EXISTING_SUMMARY ===

         === NEW_TURNS ===
         Turn 1:
         User: <full user message 1>
         Assistant: <full assistant reply 1>

         Turn 2:
         User: <full user message 2>
         Assistant: <full assistant reply 2>

         ... (more turns if present)
         === END_NEW_TURNS ===
         ```

       - Call the Responses API with this prompt reference and input, using the nano model configured inside the hosted prompt (no explicit model name needed in code).
   - The hosted prompt’s instructions:
     - Update the conversation summary to include the NEW_TURNS.
     - Preserve important goals, decisions, constraints, recurring issues, and facts that may matter later across technique, musicality, physiology, psychology, repertoire, and practice.
     - Keep the updated summary within ~400–500 tokens (hard cap 500) and avoid redundant restatement.
   - The response `output_text` from this call becomes `newGlobalSummary` (string).

5. **Update brief**
   - Set:
     - `brief.global_summary = newGlobalSummary`
     - `brief.last_summarized_message_id = max assistant message id in olderPart`
   - Persist via `saveBrief(chat_id, user.id, brief)`.

6. **Future prompts**
   - On the next turn:
     - `globalSummary` will reflect everything up to `last_summarized_message_id`.
     - `chunkBuffer` will logically start from the first message after `last_summarized_message_id`, so only the remaining non‑summarized turns + new turns accumulate there.

---

## 6. Multi‑Model Behavior (Mini vs Deep‑Dive)

The memory system is explicitly **model‑agnostic**:

- Any assistant message, regardless of model, becomes part of:
  - the raw tail (if it’s among the last K turns), and
  - the next chunk summarization input once it’s in `olderPart`.

Implementation details:

- When saving assistant messages, store `model_variant` in `messages.metadata` (or a dedicated column).
- When building prompts / summaries:
  - You can optionally annotate turns with model info (e.g. “Assistant (deep dive): ...”), but this is not required on day one.
- The token budgets and K are **shared** across model variants; deep‑dive turns are simply longer, causing the system to hit `CHUNK_SUMMARIZE_THRESHOLD` a bit earlier.

No special branching logic is required per model variant for correctness.

---

## 7. Replacement of MEMORY_CARD System

We are fully replacing the MEMORY_CARD system; no migration of old brief data is required in development.

Implementation checklist:

1. **Remove MEMORY_CARD plumbing**
   - Delete `memoryCardFilter` usage in `message.service.js`.
   - Remove all `<MEMORY_CARD>...</MEMORY_CARD>` instructions from prompts.
   - Remove MEMORY_CARD parsing, update calls, and `memory_cards` manipulation in `brief.service.js` and anywhere else.

2. **Simplify `conversation_briefs`**
   - Drop legacy fields (`summary`, `memory_cards`, `initial_outline`) from new code paths.
   - Treat `brief.brief` as containing only `global_summary` and `last_summarized_message_id` for v2.

3. **Wire new memory builder**
   - Introduce a single code path that:
     - Reads `global_summary` + `last_summarized_message_id`.
     - Reconstructs turns since `last_summarized_message_id`.
     - Builds `memoryText` as described in 5.1 and injects it into the main model prompt.

4. **Wire chunked summarization**
   - Implement `maybeUpdateGlobalSummary` (or similar) and call it after each turn completes:
     - Compute `chunkBuffer` and token counts.
     - Call gpt‑5‑nano when `CHUNK_SUMMARIZE_THRESHOLD` is exceeded.
     - Update `global_summary` and `last_summarized_message_id`.

5. **Cleanup / validation**
   - Remove any remaining MEMORY_CARD‑specific logging and docs.
   - Verify that all chats use the new memory system exclusively.

---

## 8. Testing & Observability

### 8.1 Unit Tests

- Token accounting helpers:
  - Ensure `approxTokens` (or equivalent) is consistent across memory builder and summarizer.
- Memory builder:
  - Given a set of messages and a brief with `global_summary` and `last_summarized_message_id`, verify:
    - Correct tail selection (last K turns only).
    - Correct token budgeting behavior when near `PROMPT_MEMORY_BUDGET`.
    - Multi‑model turns are treated identically.
- Chunked summarization helper:
  - Given various `chunkBuffer` sizes, verify that:
    - Summarization triggers only when threshold is exceeded and olderPart is non‑empty.
    - `last_summarized_message_id` is correctly advanced.

### 8.2 Integration Tests / Manual

- Short chats:
  - Verify global summary stays empty and the system behaves like a normal sliding window.
- Long chats:
  - Confirm that:
    - Last K turns are always present verbatim in the prompt.
    - Older facts appear in `global_summary` after chunk boundaries.
    - No errors occur when switching between mini and deep‑dive models mid‑chat.

### 8.3 Logging

- Add structured logs whenever:
  - A chunk summarization runs (token counts before/after, number of turns compressed).
  - The memory builder has to drop tail turns or truncate the global summary for prompt budget reasons.

These logs will be critical to tuning `K`, `SUMMARY_TOKEN_CAP`, `PROMPT_MEMORY_BUDGET`, and `CHUNK_SUMMARIZE_THRESHOLD`.

---

## 9. Background Behavior & UX Impact

### 9.1 Where summary work runs

- All summarization logic (token counting, chunk detection, gpt‑5‑nano calls, Supabase writes) runs **entirely on the backend**.
- Once a turn is accepted by the API, the memory update can proceed even if:
  - The user navigates away from the chat,
  - The app is backgrounded or the phone sleeps,
  - The streaming connection is closed on the client side.
- Summarization must not emit any streaming events; it should only affect server‑side state (`conversation_briefs`).

### 9.2 Interaction with streaming responses

- The primary user experience is driven by the streaming of the main assistant reply:
  - We should prioritize **fast, smooth streaming** of `content.delta` and completion events.
  - Chunked summarization must not delay initial tokens or completion of the main response.
- Implementation guidance:
  - Perform `maybeUpdateGlobalSummary` **after** the main response has streamed and we have a complete assistant message.
  - Where practical, decouple summarization from the HTTP response lifecycle:
    - Either run it in the `finally` block **after** the response has been ended, or
    - Fire it as a background async task that is not awaited for the client’s request to complete.
  - Summarization failures should be logged but must not affect the user’s visible response.

### 9.3 Mobile app behavior

- The React Native app (`ArcoScribeApp`) only:
  - Streams messages from `/v1/message` and `/v1/message/first`,
  - Reads chat/message metadata via `SupabaseChatService`.
- It does **not** read or write `conversation_briefs`, so:
  - Switching to this new memory system will not change mobile UI behavior directly.
  - Users should not see any new latency, spinners, or state changes tied to summarization.

### 9.4 Performance considerations

- Chunk summarization is relatively cheap (gpt‑5‑nano, ~5–6k input tokens max, ≤500 output), but we still:
  - Trigger it only when `CHUNK_SUMMARIZE_THRESHOLD` is exceeded.
  - Avoid running multiple summarizations concurrently for the same chat (simple per‑chat in‑flight guard if needed).
  - Log duration of nano calls and brief upserts for tuning.

---

## 10. Configuration Knobs (Env / Config)

Expose these as config values (with suggested initial defaults):

- `MEMORY_K_RAW_TURNS` (default `3`).
- `MEMORY_SUMMARY_TOKEN_CAP` (default `500`).
- `MEMORY_PROMPT_TOKEN_BUDGET` (default `3000`).
- `MEMORY_CHUNK_SUMMARIZE_THRESHOLD` (default `6000`).
- `MEMORY_SUMMARIZER_MODEL` (e.g. `gpt-5.1-nano`).
- `PROMPT_ID_SUMMARY_GLOBAL` (default `'pmpt_6917ebe9367c819396fe4840cf0f0e050c18a965a3366120'`).
- `PROMPT_VERSION_SUMMARY_GLOBAL` (string version set to match the hosted prompt in OpenAI).

This allows future tuning without code changes.
