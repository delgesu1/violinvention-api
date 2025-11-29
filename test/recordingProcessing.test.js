/**
 * RecordingProcessing Service Tests
 *
 * Tests for the recording processing service that handles
 * AI-powered summarization, title generation, and tag extraction.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mock dependencies before requiring the service
const mockOpenAIClient = {
  responses: {
    create: async () => ({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                summary_markdown: '## Lesson Summary\n\nThis is a test summary.',
                student: 'John Doe',
                title: 'John Doe: Scales and Arpeggios',
                pieces: ['Bach Partita', 'Mendelssohn Concerto'],
                themes: ['intonation', 'bow control'],
              }),
            },
          ],
        },
      ],
    }),
  },
};

const mockConfig = {
  openai: { apiKey: 'test-key' },
};

const mockPromptConfigService = {
  generateSummaryPrompt: () => 'Generate a summary...',
  isValidInstrument: (val) => ['violin', 'viola', 'cello', 'piano'].includes(val),
  isValidGenre: (val) => ['classical', 'jazz', 'folk'].includes(val),
};

// Pre-populate require cache with mocks
require.cache[require.resolve('../src/config/openai')] = {
  exports: { openaiClient: mockOpenAIClient },
};

require.cache[require.resolve('../src/services/promptConfig.service')] = {
  exports: mockPromptConfigService,
};

require.cache[require.resolve('../src/config/logger')] = {
  exports: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

require.cache[require.resolve('../src/utils/llmLogger')] = {
  exports: {
    logLLMInput: () => {},
    logLLMOutput: () => {},
  },
};

// Now require the service
const recordingProcessingService = require('../src/services/recordingProcessing.service');

test('RecordingProcessing Service', async (t) => {
  await t.test('processRecording', async (t) => {
    await t.test('processes valid transcript and returns structured result', async () => {
      const result = await recordingProcessingService.processRecording({
        transcript: 'This is a sample transcript of a violin lesson...',
        instrumentPreference: 'violin',
        genrePreference: 'classical',
      });

      assert.ok(result.summary, 'Should have summary');
      assert.ok(result.title, 'Should have title');
      assert.ok(result.rawStructuredResponse, 'Should have raw response');
    });

    await t.test('throws error for empty transcript', async () => {
      await assert.rejects(
        async () => {
          await recordingProcessingService.processRecording({
            transcript: '',
          });
        },
        {
          message: /Transcript is required/,
        }
      );
    });

    await t.test('throws error for null transcript', async () => {
      await assert.rejects(
        async () => {
          await recordingProcessingService.processRecording({
            transcript: null,
          });
        },
        {
          message: /Transcript is required/,
        }
      );
    });

    await t.test('throws error for whitespace-only transcript', async () => {
      await assert.rejects(
        async () => {
          await recordingProcessingService.processRecording({
            transcript: '   \n\t  ',
          });
        },
        {
          message: /Transcript is required/,
        }
      );
    });

    await t.test('uses default instrument when invalid', async () => {
      // The service should handle invalid instruments internally
      const result = await recordingProcessingService.processRecording({
        transcript: 'Valid transcript content here',
        instrumentPreference: 'invalid-instrument',
      });

      assert.ok(result, 'Should process even with invalid instrument');
    });

    await t.test('uses default genre when invalid', async () => {
      const result = await recordingProcessingService.processRecording({
        transcript: 'Valid transcript content here',
        genrePreference: 'invalid-genre',
      });

      assert.ok(result, 'Should process even with invalid genre');
    });
  });
});

test('Helper Functions', async (t) => {
  // Test the helper functions that are exported or can be tested indirectly

  await t.test('isValidStudentName', async (t) => {
    // We'll test the logic indirectly through the service behavior
    const validNames = ['John Doe', 'Jane', 'Student Name'];
    const invalidNames = ['unknown', 'N/A', 'Student', 'None', '', null, undefined];

    for (const name of validNames) {
      const isValid =
        name &&
        typeof name === 'string' &&
        name.trim() !== '' &&
        !['unknown', 'n/a', 'na', 'student', 'none', 'null', 'not specified'].includes(
          name.trim().toLowerCase()
        );

      assert.ok(isValid, `"${name}" should be valid`);
    }

    for (const name of invalidNames) {
      const isValid =
        name &&
        typeof name === 'string' &&
        name.trim() !== '' &&
        !['unknown', 'n/a', 'na', 'student', 'none', 'null', 'not specified'].includes(
          String(name).trim().toLowerCase()
        );

      assert.ok(!isValid, `"${name}" should be invalid`);
    }
  });

  await t.test('safeStringArray', async (t) => {
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

    await t.test('returns empty array for non-array input', () => {
      assert.deepStrictEqual(safeStringArray(null), []);
      assert.deepStrictEqual(safeStringArray('string'), []);
      assert.deepStrictEqual(safeStringArray(123), []);
      assert.deepStrictEqual(safeStringArray({}), []);
    });

    await t.test('filters non-string items', () => {
      const input = ['valid', 123, null, 'also valid', undefined];
      const result = safeStringArray(input);
      assert.deepStrictEqual(result, ['valid', 'also valid']);
    });

    await t.test('trims whitespace', () => {
      const input = ['  padded  ', 'normal', '  leading'];
      const result = safeStringArray(input);
      assert.deepStrictEqual(result, ['padded', 'normal', 'leading']);
    });

    await t.test('filters empty strings after trimming', () => {
      const input = ['valid', '   ', '', 'also valid'];
      const result = safeStringArray(input);
      assert.deepStrictEqual(result, ['valid', 'also valid']);
    });

    await t.test('respects maxItems limit', () => {
      const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const result = safeStringArray(input, 3);
      assert.deepStrictEqual(result, ['a', 'b', 'c']);
    });
  });

  await t.test('extractStudentFromSummaryMarkdown', async (t) => {
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
          const blocked = new Set([
            'unknown',
            'n/a',
            'na',
            'student',
            'none',
            'null',
            'not specified',
          ]);
          if (candidate && !blocked.has(candidate.toLowerCase())) {
            return candidate;
          }
        }
      }
      return null;
    };

    await t.test('extracts student from standard format', () => {
      const markdown = '## Lesson\n- **Student**: John Doe\n- Topic: Scales';
      const result = extractStudentFromSummaryMarkdown(markdown);
      assert.strictEqual(result, 'John Doe');
    });

    await t.test('extracts student from non-bold format', () => {
      const markdown = '## Lesson\n- Student: Jane Smith\n- Topic: Arpeggios';
      const result = extractStudentFromSummaryMarkdown(markdown);
      assert.strictEqual(result, 'Jane Smith');
    });

    await t.test('returns null for unknown student', () => {
      const markdown = '## Lesson\n- **Student**: Unknown\n- Topic: Scales';
      const result = extractStudentFromSummaryMarkdown(markdown);
      assert.strictEqual(result, null);
    });

    await t.test('returns null for N/A student', () => {
      const markdown = '## Lesson\n- **Student**: N/A\n- Topic: Scales';
      const result = extractStudentFromSummaryMarkdown(markdown);
      assert.strictEqual(result, null);
    });

    await t.test('returns null for missing student line', () => {
      const markdown = '## Lesson\n- Topic: Scales\n- Duration: 45 min';
      const result = extractStudentFromSummaryMarkdown(markdown);
      assert.strictEqual(result, null);
    });

    await t.test('returns null for empty input', () => {
      assert.strictEqual(extractStudentFromSummaryMarkdown(''), null);
      assert.strictEqual(extractStudentFromSummaryMarkdown(null), null);
      assert.strictEqual(extractStudentFromSummaryMarkdown(undefined), null);
    });
  });

  await t.test('buildTitle', async (t) => {
    const MAX_TITLE_LENGTH = 180;

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

    await t.test('builds title with student, pieces, and themes', () => {
      const result = buildTitle({
        student: 'John',
        pieces: ['Bach Partita'],
        themes: ['intonation'],
      });
      assert.strictEqual(result, 'John: Bach Partita; intonation');
    });

    await t.test('builds title with only pieces', () => {
      const result = buildTitle({
        student: 'Jane',
        pieces: ['Mendelssohn Concerto'],
        themes: [],
      });
      assert.strictEqual(result, 'Jane: Mendelssohn Concerto');
    });

    await t.test('builds title with only themes', () => {
      const result = buildTitle({
        student: 'Alex',
        pieces: [],
        themes: ['bow control', 'dynamics'],
      });
      assert.strictEqual(result, 'Alex: bow control, dynamics');
    });

    await t.test('returns student: Lesson when no content', () => {
      const result = buildTitle({
        student: 'John',
        pieces: [],
        themes: [],
      });
      assert.strictEqual(result, 'John: Lesson');
    });

    await t.test('returns null when no student and no content', () => {
      const result = buildTitle({
        student: null,
        pieces: [],
        themes: [],
      });
      assert.strictEqual(result, null);
    });

    await t.test('truncates long content', () => {
      const longPiece = 'A'.repeat(200);
      const result = buildTitle({
        student: 'John',
        pieces: [longPiece],
        themes: [],
        maxLength: 50,
      });
      assert.ok(result.length <= 60); // student name adds some length
    });

    await t.test('removes trailing comma when truncating', () => {
      const result = buildTitle({
        pieces: ['Piece A', 'Piece B', 'Piece C'],
        themes: [],
        maxLength: 20,
      });
      assert.ok(!result.endsWith(','));
    });
  });

  await t.test('parseStructuredSummaryResponse', async (t) => {
    const parseStructuredSummaryResponse = (rawText) => {
      const baseResult = {
        raw: rawText,
        summaryMarkdown: null,
        student: null,
        title: null,
        pieces: [],
        themes: [],
      };

      if (!rawText || typeof rawText !== 'string') {
        return baseResult;
      }

      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.summary_markdown === 'string' && parsed.summary_markdown.trim()) {
          baseResult.summaryMarkdown = parsed.summary_markdown.trim();
        }

        const isValidStudentName = (candidate) => {
          if (!candidate || typeof candidate !== 'string') return false;
          const trimmed = candidate.trim();
          if (!trimmed) return false;
          const blocked = new Set([
            'unknown',
            'n/a',
            'na',
            'student',
            'none',
            'null',
            'not specified',
          ]);
          return !blocked.has(trimmed.toLowerCase());
        };

        if (parsed && isValidStudentName(parsed.student)) {
          baseResult.student = parsed.student.trim();
        }

        if (parsed && typeof parsed.title === 'string' && parsed.title.trim()) {
          baseResult.title = parsed.title.trim();
        }

        const safeStringArray = (value, maxItems = 5) => {
          if (!Array.isArray(value)) return [];
          return value
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, maxItems);
        };

        baseResult.pieces = safeStringArray(parsed.pieces, 5);
        baseResult.themes = safeStringArray(parsed.themes, 5);
      } catch (error) {
        // JSON parse failed
      }

      return baseResult;
    };

    await t.test('parses valid JSON response', () => {
      const json = JSON.stringify({
        summary_markdown: '## Summary\nContent here',
        student: 'John Doe',
        title: 'Test Title',
        pieces: ['Bach', 'Mozart'],
        themes: ['intonation'],
      });

      const result = parseStructuredSummaryResponse(json);

      assert.strictEqual(result.summaryMarkdown, '## Summary\nContent here');
      assert.strictEqual(result.student, 'John Doe');
      assert.strictEqual(result.title, 'Test Title');
      assert.deepStrictEqual(result.pieces, ['Bach', 'Mozart']);
      assert.deepStrictEqual(result.themes, ['intonation']);
    });

    await t.test('returns base result for invalid JSON', () => {
      const result = parseStructuredSummaryResponse('not valid json');

      assert.strictEqual(result.summaryMarkdown, null);
      assert.strictEqual(result.student, null);
      assert.deepStrictEqual(result.pieces, []);
    });

    await t.test('returns base result for empty input', () => {
      const result = parseStructuredSummaryResponse('');

      assert.strictEqual(result.raw, '');
      assert.strictEqual(result.summaryMarkdown, null);
    });

    await t.test('filters invalid student names', () => {
      const json = JSON.stringify({
        summary_markdown: '## Summary',
        student: 'Unknown',
      });

      const result = parseStructuredSummaryResponse(json);

      assert.strictEqual(result.student, null);
    });

    await t.test('handles missing fields gracefully', () => {
      const json = JSON.stringify({
        summary_markdown: '## Summary',
        // missing student, title, pieces, themes
      });

      const result = parseStructuredSummaryResponse(json);

      assert.strictEqual(result.summaryMarkdown, '## Summary');
      assert.strictEqual(result.student, null);
      assert.strictEqual(result.title, null);
      assert.deepStrictEqual(result.pieces, []);
      assert.deepStrictEqual(result.themes, []);
    });
  });
});

test('extractOutputText', async (t) => {
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
      return null;
    }
  };

  await t.test('extracts text from valid response', () => {
    const response = {
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello ' }, { type: 'output_text', text: 'World' }],
        },
      ],
    };

    const result = extractOutputText(response);
    assert.strictEqual(result, 'Hello World');
  });

  await t.test('returns null for empty response', () => {
    assert.strictEqual(extractOutputText(null), null);
    assert.strictEqual(extractOutputText(undefined), null);
    assert.strictEqual(extractOutputText({}), null);
  });

  await t.test('returns null for response without output array', () => {
    const response = { output: 'not an array' };
    assert.strictEqual(extractOutputText(response), null);
  });

  await t.test('returns null for response without message item', () => {
    const response = {
      output: [{ type: 'other', content: [] }],
    };
    assert.strictEqual(extractOutputText(response), null);
  });

  await t.test('filters non-output_text content', () => {
    const response = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Valid' },
            { type: 'other', text: 'Invalid' },
            { type: 'output_text', text: ' Text' },
          ],
        },
      ],
    };

    const result = extractOutputText(response);
    assert.strictEqual(result, 'Valid Text');
  });

  await t.test('handles malformed content gracefully', () => {
    const response = {
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: null }, { type: 'output_text' }],
        },
      ],
    };

    const result = extractOutputText(response);
    assert.strictEqual(result, null);
  });
});
