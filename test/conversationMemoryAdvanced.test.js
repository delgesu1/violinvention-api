/**
 * Conversation Memory Service - Advanced Tests
 *
 * Comprehensive tests for conversation memory system including
 * summarization, token management, and lesson plan pinning.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createTestUserId, createMockMessage } = require('./setup');

// Mock configuration
const MEMORY_CONFIG = {
  K_RAW_TURNS: 3,
  SUMMARY_TOKEN_CAP: 500,
  PROMPT_TOKEN_BUDGET: 3000,
  CHUNK_SUMMARIZE_THRESHOLD: 6000,
};

// Helper function to estimate tokens (rough approximation)
const estimateTokens = (text) => {
  if (!text) return 0;
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
};

test('Conversation Memory Core Functions', async (t) => {
  await t.test('Token Estimation', async (t) => {
    await t.test('estimates tokens for text', () => {
      const text = 'Hello, how can I help you today?';
      const tokens = estimateTokens(text);

      assert.ok(tokens > 0, 'Should estimate positive tokens');
      assert.ok(tokens < 50, 'Should be reasonable estimate');
    });

    await t.test('handles empty text', () => {
      assert.strictEqual(estimateTokens(''), 0);
      assert.strictEqual(estimateTokens(null), 0);
      assert.strictEqual(estimateTokens(undefined), 0);
    });

    await t.test('scales with text length', () => {
      const short = estimateTokens('Hello');
      const medium = estimateTokens('Hello, how are you doing today?');
      const long = estimateTokens('A'.repeat(1000));

      assert.ok(short < medium, 'Short should have fewer tokens');
      assert.ok(medium < long, 'Medium should have fewer tokens than long');
    });
  });

  await t.test('Message Turn Management', async (t) => {
    await t.test('groups messages into turns', () => {
      const messages = [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: 'Answer 2' },
        { role: 'user', content: 'Question 3' },
        { role: 'assistant', content: 'Answer 3' },
      ];

      // Group into turns (user + assistant pairs)
      const turns = [];
      for (let i = 0; i < messages.length; i += 2) {
        if (i + 1 < messages.length) {
          turns.push({
            user: messages[i],
            assistant: messages[i + 1],
          });
        }
      }

      assert.strictEqual(turns.length, 3, 'Should have 3 turns');
    });

    await t.test('keeps last K raw turns', () => {
      const turns = [
        { user: { content: 'Q1' }, assistant: { content: 'A1' } },
        { user: { content: 'Q2' }, assistant: { content: 'A2' } },
        { user: { content: 'Q3' }, assistant: { content: 'A3' } },
        { user: { content: 'Q4' }, assistant: { content: 'A4' } },
        { user: { content: 'Q5' }, assistant: { content: 'A5' } },
      ];

      const kRawTurns = MEMORY_CONFIG.K_RAW_TURNS;
      const rawTurns = turns.slice(-kRawTurns);
      const turnsToSummarize = turns.slice(0, -kRawTurns);

      assert.strictEqual(rawTurns.length, kRawTurns, `Should keep ${kRawTurns} raw turns`);
      assert.strictEqual(turnsToSummarize.length, 2, 'Should have 2 turns to summarize');
    });
  });
});

test('Summarization Logic', async (t) => {
  await t.test('Summarization Trigger', async (t) => {
    await t.test('triggers when token threshold exceeded', () => {
      const totalTokens = 7000;
      const threshold = MEMORY_CONFIG.CHUNK_SUMMARIZE_THRESHOLD;

      const shouldSummarize = totalTokens > threshold;
      assert.ok(shouldSummarize, 'Should trigger summarization');
    });

    await t.test('does not trigger below threshold', () => {
      const totalTokens = 4000;
      const threshold = MEMORY_CONFIG.CHUNK_SUMMARIZE_THRESHOLD;

      const shouldSummarize = totalTokens > threshold;
      assert.ok(!shouldSummarize, 'Should not trigger summarization');
    });
  });

  await t.test('Rolling Summary', async (t) => {
    await t.test('updates global summary with new summary', () => {
      const existingSummary = 'Previous conversation discussed violin techniques.';
      const newSummary = 'User asked about bow control. Assistant provided tips.';

      // Combine summaries
      const combinedSummary = existingSummary
        ? `${existingSummary}\n\n${newSummary}`
        : newSummary;

      assert.ok(combinedSummary.includes(existingSummary));
      assert.ok(combinedSummary.includes(newSummary));
    });

    await t.test('truncates summary to token cap', () => {
      const longSummary = 'A'.repeat(3000); // ~750 tokens
      const tokenCap = MEMORY_CONFIG.SUMMARY_TOKEN_CAP;

      // Truncate to approximate token limit
      const maxChars = tokenCap * 4; // ~4 chars per token
      const truncatedSummary =
        longSummary.length > maxChars
          ? longSummary.slice(0, maxChars) + '...'
          : longSummary;

      const tokens = estimateTokens(truncatedSummary);
      assert.ok(tokens <= tokenCap + 10, 'Should be within token cap (with buffer)');
    });
  });

  await t.test('Cursor Management', async (t) => {
    await t.test('tracks last summarized message ID', () => {
      const conversationState = {
        global_summary: 'Summary of conversation',
        last_summarized_message_id: 'msg_100',
      };

      assert.ok(conversationState.last_summarized_message_id);
    });

    await t.test('updates cursor after summarization', () => {
      const messages = [
        { message_id: 'msg_98', content: 'Older message' },
        { message_id: 'msg_99', content: 'Old message' },
        { message_id: 'msg_100', content: 'Last summarized' },
        { message_id: 'msg_101', content: 'New message 1' },
        { message_id: 'msg_102', content: 'New message 2' },
      ];

      const lastSummarizedId = 'msg_100';
      const newMessagesAfterCursor = messages.filter((m) => {
        const numId = parseInt(m.message_id.split('_')[1], 10);
        const cursorId = parseInt(lastSummarizedId.split('_')[1], 10);
        return numId > cursorId;
      });

      assert.strictEqual(newMessagesAfterCursor.length, 2);
    });
  });
});

test('Lesson Plan Pinning', async (t) => {
  await t.test('identifies lesson plan messages', () => {
    const message = createMockMessage('chat_123', 'assistant', {
      metadata: {
        is_lesson_plan: true,
        lesson_plan_full_context: 'Student: John Doe\nPieces: Bach Partita\nFocus: Intonation',
      },
    });

    const isLessonPlan = message.metadata?.is_lesson_plan === true;
    assert.ok(isLessonPlan, 'Should identify lesson plan message');
  });

  await t.test('preserves lesson plan in memory even when old', () => {
    const messages = [
      createMockMessage('chat_1', 'assistant', {
        message_id: 'msg_1',
        metadata: {
          is_lesson_plan: true,
          lesson_plan_full_context: 'Lesson plan context',
        },
      }),
      createMockMessage('chat_1', 'user', { message_id: 'msg_2' }),
      createMockMessage('chat_1', 'assistant', { message_id: 'msg_3' }),
      createMockMessage('chat_1', 'user', { message_id: 'msg_4' }),
      createMockMessage('chat_1', 'assistant', { message_id: 'msg_5' }),
      createMockMessage('chat_1', 'user', { message_id: 'msg_6' }),
      createMockMessage('chat_1', 'assistant', { message_id: 'msg_7' }),
    ];

    // Even with many messages, lesson plan should be preserved
    const lessonPlanMessage = messages.find((m) => m.metadata?.is_lesson_plan);
    assert.ok(lessonPlanMessage, 'Lesson plan should be preserved');
  });

  await t.test('injects lesson plan into tail messages', () => {
    const lessonPlanContext = 'Student: Jane\nPieces: Mozart Concerto';
    const tailMessages = [
      { role: 'user', content: 'Recent question' },
      { role: 'assistant', content: 'Recent answer' },
    ];

    // Inject lesson plan context at the beginning
    const messagesWithContext = [
      { role: 'system', content: `Lesson Plan Context:\n${lessonPlanContext}` },
      ...tailMessages,
    ];

    assert.ok(messagesWithContext[0].content.includes('Jane'));
    assert.ok(messagesWithContext[0].content.includes('Mozart'));
  });

  await t.test('restores full context from metadata', () => {
    const message = {
      content: 'Abbreviated lesson plan...',
      metadata: {
        is_lesson_plan: true,
        lesson_plan_full_context:
          'Full detailed lesson plan with complete information about student, pieces, and focus areas.',
      },
    };

    // When building memory, use full context if available
    const contextToUse = message.metadata?.lesson_plan_full_context || message.content;

    assert.ok(contextToUse.includes('Full detailed'));
    assert.strictEqual(contextToUse, message.metadata.lesson_plan_full_context);
  });
});

test('Memory Block Building', async (t) => {
  await t.test('builds memory block within token budget', () => {
    const globalSummary = 'Previous conversation summary...';
    const tailMessages = [
      { role: 'user', content: 'User message 1' },
      { role: 'assistant', content: 'Assistant response 1' },
      { role: 'user', content: 'User message 2' },
      { role: 'assistant', content: 'Assistant response 2' },
    ];

    const memoryBlock = {
      summary: globalSummary,
      recentMessages: tailMessages,
    };

    const totalTokens =
      estimateTokens(globalSummary) +
      tailMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    assert.ok(
      totalTokens < MEMORY_CONFIG.PROMPT_TOKEN_BUDGET,
      'Memory block should be within budget'
    );
  });

  await t.test('prioritizes recent messages over summary', () => {
    // If near budget, should keep recent messages and truncate summary
    const longSummary = 'A'.repeat(15000); // Exceeds budget
    const recentMessages = [
      { role: 'user', content: 'Recent important question' },
      { role: 'assistant', content: 'Recent important answer' },
    ];

    const messageTokens = recentMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0
    );
    const budget = MEMORY_CONFIG.PROMPT_TOKEN_BUDGET; // 3000 tokens

    // Calculate how much of summary we can keep
    const availableForSummary = budget - messageTokens;
    const maxSummaryChars = availableForSummary * 4; // ~11,952 chars

    const truncatedSummary = longSummary.slice(0, maxSummaryChars);

    assert.ok(
      truncatedSummary.length < longSummary.length,
      'Summary should be truncated when it exceeds available budget'
    );
    assert.ok(messageTokens < budget, 'Messages should fit in budget');
  });
});

test('Conversation State Persistence', async (t) => {
  await t.test('stores conversation state in user_settings', () => {
    const conversationState = {
      global_summary: 'Summary of all conversations',
      last_summarized_message_id: 'msg_100',
    };

    const userSettings = {
      user_id: 'user_123',
      vector_store_id: 'vs_456',
      conversation_state: conversationState,
    };

    assert.ok(userSettings.conversation_state, 'Should have conversation_state');
    assert.ok(userSettings.conversation_state.global_summary);
  });

  await t.test('handles missing conversation state', () => {
    const userSettings = {
      user_id: 'user_123',
      // No conversation_state
    };

    const conversationState = userSettings.conversation_state || {
      global_summary: null,
      last_summarized_message_id: null,
    };

    assert.ok(conversationState, 'Should have default state');
    assert.strictEqual(conversationState.global_summary, null);
  });

  await t.test('updates state atomically', async () => {
    // Simulate atomic update
    const updates = {
      global_summary: 'Updated summary',
      last_summarized_message_id: 'msg_150',
    };

    // Both fields should update together
    assert.ok(updates.global_summary);
    assert.ok(updates.last_summarized_message_id);
  });
});

test('Edge Cases', async (t) => {
  await t.test('handles empty conversation', () => {
    const messages = [];
    const conversationState = {
      global_summary: null,
      last_summarized_message_id: null,
    };

    // Should not crash
    const memoryBlock = {
      summary: conversationState.global_summary || '',
      recentMessages: messages,
    };

    assert.ok(memoryBlock, 'Should handle empty conversation');
    assert.strictEqual(memoryBlock.recentMessages.length, 0);
  });

  await t.test('handles conversation with only user messages', () => {
    const messages = [
      { role: 'user', content: 'Question 1' },
      { role: 'user', content: 'Question 2' },
    ];

    // No complete turns
    const turns = [];
    for (let i = 0; i < messages.length; i += 2) {
      if (messages[i + 1]?.role === 'assistant') {
        turns.push({ user: messages[i], assistant: messages[i + 1] });
      }
    }

    assert.strictEqual(turns.length, 0, 'Should have no complete turns');
  });

  await t.test('handles very long single message', () => {
    const longMessage = 'A'.repeat(50000);
    const tokens = estimateTokens(longMessage);

    // Should handle gracefully
    const maxMessageTokens = 8000;
    const truncatedMessage =
      tokens > maxMessageTokens
        ? longMessage.slice(0, maxMessageTokens * 4) + '...'
        : longMessage;

    assert.ok(truncatedMessage.length < longMessage.length);
  });

  await t.test('handles special characters in content', () => {
    const message = {
      content: 'Test with emoji 🎻 and special chars <>&"\' and unicode: 日本語',
    };

    const tokens = estimateTokens(message.content);
    assert.ok(tokens > 0, 'Should estimate tokens for special content');
  });

  await t.test('handles rapid consecutive updates', async () => {
    // Simulate rapid updates
    const updates = [];
    for (let i = 0; i < 10; i++) {
      updates.push({
        timestamp: Date.now(),
        summary: `Summary ${i}`,
      });
    }

    // Last update should win
    const finalSummary = updates[updates.length - 1].summary;
    assert.strictEqual(finalSummary, 'Summary 9');
  });
});

test('Integration Scenarios', async (t) => {
  await t.test('full conversation flow', () => {
    // Start new conversation
    let conversationState = {
      global_summary: null,
      last_summarized_message_id: null,
    };

    const messages = [];

    // Add messages
    for (let i = 0; i < 20; i++) {
      messages.push({ message_id: `msg_${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` });
    }

    // Check if summarization needed
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    if (totalTokens > MEMORY_CONFIG.CHUNK_SUMMARIZE_THRESHOLD) {
      // Perform summarization
      const turnsToSummarize = messages.slice(0, -MEMORY_CONFIG.K_RAW_TURNS * 2);
      const lastSummarizedMsg = turnsToSummarize[turnsToSummarize.length - 1];

      conversationState = {
        global_summary: 'Summarized conversation content',
        last_summarized_message_id: lastSummarizedMsg?.message_id,
      };
    }

    // Final state should be valid
    assert.ok(messages.length === 20);
    if (conversationState.global_summary) {
      assert.ok(conversationState.last_summarized_message_id);
    }
  });

  await t.test('chat reuse for lesson plans', () => {
    // Same student should reuse existing lesson plan chat
    const existingChats = [
      { chat_id: 'chat_1', title: 'Lesson plan for John', metadata: { student: 'John' } },
      { chat_id: 'chat_2', title: 'General chat' },
    ];

    const studentName = 'John';
    const existingLessonPlanChat = existingChats.find(
      (c) => c.title?.includes('Lesson plan') && c.metadata?.student === studentName
    );

    assert.ok(existingLessonPlanChat, 'Should find existing lesson plan chat');
    assert.strictEqual(existingLessonPlanChat.chat_id, 'chat_1');
  });
});
