const { supabase } = require("../config/supabase.js");
const {
    openaiClient,
    PROMPT_ID,
    PROMPT_VERSION,
    PROMPT_INSTRUCTIONS,
    PROMPT_ID_PERSONAL_LESSONS,
    PROMPT_VERSION_PERSONAL_LESSONS,
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS,
    PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE,
    PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE,
    PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE,
    PROMPT_ID_DEEPTHINK,
    PROMPT_VERSION_DEEPTHINK,
    PROMPT_INSTRUCTIONS_DEEPTHINK,
    OPENAI_MODEL,
    botClient,
    PROMPT_ID_BOT,
    PROMPT_VERSION_BOT
} = require("../config/openai");
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const { createChatWithFirstMessage } = require('./chat.service');
const { getBrief, saveBrief, updateBrief, toWire, generateOutline, approxTokens, isContentfulOutline } = require('./brief.service');
const { createMemoryCardFilter } = require('./memoryCardFilter');
const { searchVectorStore } = require('./vectorStore.service');

// Helper function to extract text from various event shapes
const getTextDelta = (ev) => {
    return (
        ev.delta ??
        ev.text ??
        ev.content ??
        ev.response?.output_text?.delta ??   // nested case
        ev.message?.content?.[0]?.text?.delta ??
        ""
    );
};

// Format Responses API streaming events for frontend compatibility
const formatResponseEventForFrontend = (responseEvent) => {
    // Debug logging removed - was causing excessive console output
    // console.log('[Responses API] Raw event:', JSON.stringify(responseEvent, null, 2));
    
    // Map Responses API streaming events to expected frontend format
    // The actual event structure may be different, so we handle both possible formats
    const eventType = responseEvent.type || responseEvent.event;
    
    switch(eventType) {
        case 'response.created':
        case 'response.started':
            return JSON.stringify({
                event: 'response.created',
                data: {
                    id: responseEvent.response?.id || responseEvent.id
                }
            }) + '\n';

        case 'response.output_item.added':
            // Handle message creation from new OpenAI API
            if (responseEvent.item?.type === 'message') {
                return JSON.stringify({
                    event: 'message.created',
                    data: {
                        id: responseEvent.item.id,
                        role: responseEvent.item.role || 'assistant'
                    }
                }) + '\n';
            }
            return null;
            
        case 'response.completed':
        case 'response.done':
            return JSON.stringify({
                event: 'response.done',
                data: {
                    status: 'completed'
                }
            }) + '\n';

        case 'response.output_item.done':
            // Only trigger completion for message items (not reasoning, etc.)
            if (responseEvent.item?.type === 'message' &&
                responseEvent.item?.status === 'completed') {
                return JSON.stringify({
                    event: 'response.done',
                    data: {
                        status: 'completed'
                    }
                }) + '\n';
            }
            return null;

        case 'error':
            return JSON.stringify({
                event: 'error',
                data: {
                    message: responseEvent.message || responseEvent.error || responseEvent.data?.message || 'Unknown error'
                }
            }) + '\n';
            
        default:
            // Silently ignore unknown event types - many are valid OpenAI events not needed for frontend
            return null;
    }
};

// Memory card instruction for conversation context management
// Uses sentinel parsing approach for reliability
const MEMORY_INSTRUCTION = `
At the end of your response, emit a memory card using this exact format on its own line:
<MEMORY_CARD>{"goal":"Master vibrato technique","decisions":["Practice 10 min daily"],"open_q":["Speed vs accuracy?"],"techniques":["vibrato"],"lesson_context":"intermediate vibrato"}</MEMORY_CARD>
Rules:
- Output the tag exactly once and nothing else after it.
- Use valid JSON with double quotes around every key and string value.
- Use the keys goal, decisions, open_q, techniques, lesson_context (arrays can be empty).
- Keep the JSON under 120 tokens total.`;

const sendMessage = async ({ message, chat_id, instruction_token, lesson_context, model = 'arco', user, req, res }) => {
    res.writeHead(200, { "Content-type": "text/plain" });

    const abortController = new AbortController();
    let responseEnded = false;
    let conversationId = null;
    let assistantMessage = '';
    let responseId = null;
    let itemId = null;

    const handleAbort = async () => {
        if (responseEnded) return;
        abortController.abort();
        
        try {
            if (!res.writableEnded && !responseEnded) {
                responseEnded = true;
                res.end();
            }
        } catch (err) {
            console.error("Error ending the response after abort:", err);
        }
    };

    req.on("aborted", handleAbort);
    res.on("close", handleAbort);
    res.on("error", (err) => console.error("Response error:", err));

    // Hoist variables for scope access in finally block
    let brief = null;
    let assistantMessageClean = "";
    let capturedCard = null;

    // Create stateful filter for this request
    const filter = createMemoryCardFilter();

    // Helper function to write sanitized UI and accumulate clean text
    const writeUI = (ui) => {
        if (!ui) return;
        // Optional guard to detect any leaks
        if (/<MEMORY_CARD>/.test(ui)) {
            console.error("SANITIZER FAIL: tag reached UI chunk");
        }
        const sanitizedEvent = JSON.stringify({
            event: 'content.delta',
            data: {
                id: 'response',
                text: ui
            }
        }) + '\n';
        res.write(sanitizedEvent);
        assistantMessageClean += ui;
    };

    try {
        const { data: chat, error: chatError } = await supabase
            .from('chats')
            .select('*')
            .eq('chat_id', chat_id)
            .eq('user_id', user.id)
            .single();

        if (chatError || !chat) {
            throw new ApiError(402, "Invalid Chat!");
        }

        // Use conversation_id (new) or fall back to thread_id (legacy)
        conversationId = chat.conversation_id || chat.thread_id;
        if (!conversationId) {
            throw new ApiError(500, "Chat has no valid conversation or thread ID");
        }

        const normalizedModel = typeof model === 'string' ? model.toLowerCase().trim() : 'arco';
        let modelVariant = normalizedModel === 'arco-pro' ? 'arco-pro' : 'arco';
        if (model && modelVariant === 'arco' && normalizedModel !== 'arco') {
            console.warn(`[DeepThink] Unsupported model variant "${model}" received, defaulting to "arco"`);
        }
        const isDeepThink = modelVariant === 'arco-pro';

        const userMessageContent = `${message} ${instruction_token}`;
        const userDisplayContent = message; // Clean message for display
        
        console.log('[Backend sendMessage] OpenAI Input Prompt:', {
            originalMessage: message,
            instructionToken: instruction_token || '(empty)',
            instructionTokenLength: instruction_token ? instruction_token.length : 0,
            finalPrompt: userMessageContent,
            finalPromptLength: userMessageContent.length,
            hasLessonContext: !!lesson_context,
            modelVariant,
        });

        // Save user message to database first
        const { data: userMsg, error: msgError } = await supabase
            .from('messages')
            .insert({
                role: 'user',
                content: userDisplayContent,
                chat_id,
                user_id: user.id,
                lesson_context: lesson_context || null,
            })
            .select()
            .single();

        if (msgError) {
            throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to save user message: ${msgError.message}`);
        }

        // Only update chat title if it's a new chat - don't update timestamps for regular messages
        if (chat.title === "New Chat") {
            // Generate title asynchronously and update database with the result
            try {
                const title = await getMessageContext(userDisplayContent);
                if (title) {
                    await supabase
                        .from('chats')
                        .update({ title })
                        .eq('chat_id', chat.chat_id);
                    console.log("Generated chat title:", title);
                }
            } catch (error) {
                console.error("Title generation error:", error);
                // Continue even if title generation fails
            }
        }
        // Note: last_message_at and updated_at are handled by frontend when message completes

        // LOAD CONVERSATION CONTEXT
        brief = await getBrief(chat_id);
        const wireBrief = toWire(brief);

        // Get both initial and recent assistant message outlines for context
        const [{ data: initialMessage }, { data: recentMessage }] = await Promise.all([
            // Get initial outline (from first assistant message)
            supabase
                .from('messages')
                .select('outline')
                .eq('chat_id', chat_id)
                .eq('role', 'assistant')
                .eq('is_initial', true)
                .not('outline', 'is', null)
                .single(),
            // Get most recent outline
            supabase
                .from('messages')
                .select('outline')
                .eq('chat_id', chat_id)
                .eq('role', 'assistant')
                .not('outline', 'is', null)
                .order('created_at', { ascending: false })
                .limit(1)
                .single()
        ]);

        const initialOutline = brief.initial_outline || initialMessage?.outline || "";
        const recentOutline = recentMessage?.outline || "";

        // Determine which outlines to include based on content
        const useInitial = isContentfulOutline(initialOutline);
        const useRecent = isContentfulOutline(recentOutline);
        const outlinesDiffer = initialOutline !== recentOutline;

        // BUILD INPUT WITH CONVERSATION CONTEXT
        // Build segments array: brief → outlines → user message → instruction
        const segments = [];

        // 1. Add conversation brief (if exists)
        if (wireBrief) {
            segments.push(`Conversation context: ${wireBrief}`);
        }

        const shouldIncludeInitial = useInitial && outlinesDiffer;
        const shouldIncludeRecent = useRecent && (outlinesDiffer || !useInitial);

        // 2. Add initial outline when it provides additional context
        if (shouldIncludeInitial) {
            segments.push(`Initial response outline: ${initialOutline}`);
        }

        // 3. Add recent outline when it supplements or replaces the initial outline
        if (shouldIncludeRecent) {
            segments.push(`Previous response outline: ${recentOutline}`);
        }

        // 4. Guarantee at least one outline is present when available
        if (!shouldIncludeInitial && !shouldIncludeRecent) {
            const fallbackOutline = recentOutline || initialOutline;
            if (fallbackOutline) {
                segments.push(`Previous response outline: ${fallbackOutline}`);
            }
        }

        // 5. Add user message and memory instruction
        segments.push(userMessageContent);
        segments.push(MEMORY_INSTRUCTION);

        let contextualInput = segments.filter(Boolean).join('\n\n');

        // Determine chat mode
        const chatMode = chat.chat_mode || 'arcoai';
        let promptId = PROMPT_ID;
        let promptVersion = PROMPT_VERSION;
        let promptInstructions = PROMPT_INSTRUCTIONS;
        let vectorSearchResults = [];
        let retrievalContext = '';

        if (chatMode === 'personal_lessons') {
            promptId = PROMPT_ID_PERSONAL_LESSONS;
            promptVersion = PROMPT_VERSION_PERSONAL_LESSONS;
            promptInstructions = PROMPT_INSTRUCTIONS_PERSONAL_LESSONS;

            vectorSearchResults = await searchVectorStore(user.id, userDisplayContent, 5);

            if (vectorSearchResults.length > 0) {
                const formatted = vectorSearchResults.map((result, index) => {
                    const attributes = result.attributes || {};
                    const title = attributes.title || attributes.lesson_title || attributes.name || `Source ${index + 1}`;
                    const lessonId = attributes.lesson_id || attributes.lessonId;
                    const date = attributes.date || attributes.lesson_date;

                    const rawContentArray = Array.isArray(result.content) ? result.content : [];
                    const extractedText = rawContentArray
                        .map((chunk) => chunk?.text || chunk?.value || '')
                        .filter(Boolean)
                        .join('\n');

                    const fallbackText = typeof result.content === 'string' ? result.content : '';
                    const combinedText = (extractedText || fallbackText || '[No excerpt available]').trim();
                    const truncatedText = combinedText.length > 600 ? `${combinedText.substring(0, 600)}…` : combinedText;

                    const headerParts = [title];
                    if (lessonId) headerParts.push(`ID: ${lessonId}`);
                    if (date) headerParts.push(`Date: ${date}`);

                    return `${headerParts.join(' • ')}\n${truncatedText}`;
                }).join('\n\n');

                retrievalContext = `Relevant lesson excerpts:\n${formatted}`;
            } else {
                console.log(`[VectorStore] No personal lesson matches found for user ${user.id} (chat ${chat_id})`);
            }

            if (isDeepThink) {
                const deepDivePromptId = PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE || PROMPT_ID_DEEPTHINK;
                if (deepDivePromptId) {
                    promptId = deepDivePromptId;
                }

                if (deepDivePromptId === PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE) {
                    promptVersion = PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE || promptVersion;
                    promptInstructions = PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE || promptInstructions;
                } else {
                    promptVersion = PROMPT_VERSION_DEEPTHINK || promptVersion;
                    promptInstructions = PROMPT_INSTRUCTIONS_DEEPTHINK || promptInstructions;
                }
            }
        } else if (isDeepThink) {
            promptId = PROMPT_ID_DEEPTHINK || PROMPT_ID;
            promptVersion = PROMPT_VERSION_DEEPTHINK || PROMPT_VERSION;
            promptInstructions = PROMPT_INSTRUCTIONS_DEEPTHINK || promptInstructions;
        }

        if (retrievalContext) {
            segments.splice(segments.length - 2, 0, retrievalContext);
            contextualInput = segments.filter(Boolean).join('\n\n');
        }

        console.log('[Conversation Context] Brief tokens:', approxTokens(wireBrief));
        console.log('[Conversation Context] Initial outline tokens:', approxTokens(initialOutline));
        console.log('[Conversation Context] Recent outline tokens:', approxTokens(recentOutline));
        console.log('[Conversation Context] Using initial:', useInitial, 'Using recent:', useRecent);
        console.log('[Conversation Context] Total context tokens:', approxTokens(contextualInput));

        const metadataPayload = {
            model_variant: modelVariant,
            ...(lesson_context ? { lesson_context: JSON.stringify(lesson_context) } : {})
        };

        let responseOptions;

        if (chatMode === 'personal_lessons') {
            const promptReference = promptId ? { id: promptId } : null;
            if (promptReference && promptVersion) {
                promptReference.version = promptVersion;
            }

            const overrideInstructions = (promptInstructions || '').trim();
            const personalInput = overrideInstructions
                ? `${overrideInstructions}\n\n${contextualInput}`
                : contextualInput;

            console.log('[OpenAI API] About to call with conversation context:', {
                chatMode,
                modelVariant,
                prompt_id: promptId,
                version: promptVersion,
                inputLength: personalInput.length,
                retrievalMode: `manual_lookup:${vectorSearchResults.length}`,
                usingPromptReference: !!promptReference
            });

            responseOptions = {
                model: OPENAI_MODEL,
                input: personalInput,
                stream: true,
                store: true,
                include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
                text: { format: { type: 'text' } },
                reasoning: { effort: 'low', summary: 'auto' },
                metadata: metadataPayload
            };

            if (promptReference) {
                responseOptions.prompt = promptReference;
            }
        } else {
            console.log('[OpenAI API] About to call with conversation context:', {
                chatMode,
                modelVariant,
                prompt_id: promptId,
                version: promptVersion,
                inputLength: contextualInput.length,
                retrievalMode: 'prompt_reference'
            });

            responseOptions = {
                prompt: {
                    id: promptId,
                    version: promptVersion
                },
                input: contextualInput,
                stream: true,
                store: true,
                include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
                text: { format: { type: 'text' } },
                reasoning: { effort: 'low', summary: 'auto' },
                metadata: metadataPayload
            };
        }

        const responseStream = await openaiClient.responses.create(responseOptions);

        // Process streaming response
        let isFirstEvent = true;
        for await (const event of responseStream) {
            if (res.writableEnded || abortController.signal.aborted) break;

            // Log the first event to see what we're actually getting
            if (isFirstEvent) {
                console.log('[OpenAI API] First response event received:', {
                    eventType: event.type || event.event,
                    eventKeys: Object.keys(event),
                    promptUsed: event.prompt_id || event.prompt?.id || 'unknown',
                    versionUsed: event.prompt_version || event.prompt?.version || 'unknown'
                });
                isFirstEvent = false;
            }

            // Process events by type with stateful filtering
            const eventType = event.type || event.event;

            if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                // Delta events: process through stateful filter
                const rawText = getTextDelta(event);
                const { ui, card } = filter.feed(rawText);

                if (ui) writeUI(ui);
                if (card && !capturedCard) capturedCard = card;
                continue;  // DO NOT also write the raw delta event

            } else if (eventType === 'response.created' || eventType === 'response.started') {
                // Created/Started events: forward as-is
                responseId = event.response?.id || event.id;
                const eventData = formatResponseEventForFrontend(event);
                if (eventData) res.write(eventData);

            } else if (eventType === 'response.completed' || eventType === 'response.done') {
                // Never forward model text from completed; sanitize if present
                const safe = { ...event };
                if (safe.response?.output_text) {
                    safe.response.output_text.delta = "";
                    safe.response.output_text.text = "";
                    safe.response.output_text.final = "";
                }
                const eventData = formatResponseEventForFrontend(safe);
                if (eventData) res.write(eventData);

            } else {
                // Forward non-text events as-is
                const eventData = formatResponseEventForFrontend(event);
                if (eventData) res.write(eventData);
            }
        }

        // Flush leftover UI tail after stream ends
        const tail = filter.flush();
        if (tail.ui) writeUI(tail.ui);

    } catch (error) {
        console.error("Error in sendMessage:", error);
        
        // Determine error type and create appropriate response
        let errorMessage = error.message;
        let errorCode = 'UNKNOWN_ERROR';
        
        if (error.status === 400) {
            errorCode = 'BAD_REQUEST';
            // For OpenAI API errors, use the specific error message
            errorMessage = error.message || 'Invalid request. Please check your message and try again.';
        } else if (error.status === 401) {
            errorCode = 'UNAUTHORIZED';
            errorMessage = error.message || 'Authentication failed. Please check your API configuration.';
        } else if (error.status === 402) {
            errorCode = 'QUOTA_EXCEEDED';
            errorMessage = error.message || 'API quota exceeded. Please try again later.';
        } else if (error.status === 429) {
            errorCode = 'RATE_LIMITED';
            errorMessage = error.message || 'Too many requests. Please slow down and try again.';
        } else if (error.status >= 500) {
            errorCode = 'SERVER_ERROR';
            errorMessage = error.message || 'Server error occurred. Please try again.';
        } else if (error.code === 'ECONNABORTED') {
            errorCode = 'TIMEOUT';
            errorMessage = 'Request timed out. Please try again.';
        } else if (error.name === 'AbortError') {
            errorCode = 'ABORTED';
            errorMessage = 'Request was cancelled.';
        }
        
        // Send structured error to frontend
        const errorEvent = JSON.stringify({
            event: 'error',
            data: { 
                message: errorMessage,
                code: errorCode,
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            }
        }) + '\n';
        
        if (!res.writableEnded) {
            res.write(errorEvent);
        }
    } finally {
        // Save assistant message and update conversation context
        if (assistantMessageClean && !abortController.signal.aborted) {
            try {
                let outline = "";
                let nextBrief = brief;

                // Process captured MEMORY_CARD if found
                if (capturedCard) {
                    try {
                        const memoryCard = JSON.parse(capturedCard);
                        nextBrief = updateBrief(brief, memoryCard);
                        console.log('[Brief Updated] New token count:', approxTokens(toWire(nextBrief)));
                    } catch (parseError) {
                        console.error('[MEMORY_CARD] Parse error, keeping previous brief:', parseError, {
                            cardPreview: capturedCard.slice(0, 200)
                        });
                    }
                }

                // Final safety scrub before database storage (paranoia-level)
                assistantMessageClean = assistantMessageClean.replace(/<MEMORY_CARD>[\s\S]*?<\/MEMORY_CARD>\s*$/g, '');

                // Generate outline for next turn from clean text
                outline = generateOutline(assistantMessageClean);

                // Persist updated brief if needed
                if (capturedCard || !nextBrief.initial_outline) {
                    if (!nextBrief.initial_outline) {
                        nextBrief = {
                            ...nextBrief,
                            initial_outline: outline,
                        };
                    }

                    try {
                        await saveBrief(chat_id, user.id, nextBrief);
                    } catch (briefError) {
                        console.error('[Brief Save] Failed to persist updated brief:', briefError);
                    }
                }

                // Save assistant message with outline
                const { error: saveError } = await supabase
                    .from('messages')
                    .insert({
                        role: 'assistant',
                        content: assistantMessageClean,
                        outline: outline,
                        chat_id,
                        user_id: user.id,
                        response_id: responseId,
                        item_id: itemId,
                    });

                if (saveError) {
                    console.error("Error saving assistant message:", saveError);
                }
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

const getMessageContext = async (inputMessage) => {
    try {
        console.log('[Title Generation] Starting title generation for message:', {
            messageLength: inputMessage.length,
            messagePreview: inputMessage.substring(0, 100) + '...',
            promptId: PROMPT_ID_BOT,
            promptVersion: PROMPT_VERSION_BOT
        });

        // Use Responses API to generate title from first message
        const response = await botClient.responses.create({
            prompt: {
                id: PROMPT_ID_BOT,
                version: PROMPT_VERSION_BOT
            },
            input: `Generate a short, descriptive title (max 50 characters) for this message: "${inputMessage}"`,
            stream: false, // Non-streaming for title generation
        });

        console.log('[Title Generation] Response received:', {
            hasOutputText: !!response.output_text,
            hasOutput: !!response.output,
            outputStructure: response.output ? response.output.map(item => Object.keys(item)) : 'null',
            rawResponse: process.env.NODE_ENV === 'development' ? response : 'hidden'
        });

        // Extract title from response - check both output_text and content structure
        const title = response.output_text || response.output?.[0]?.content?.[0]?.text || null;

        console.log('[Title Generation] Extracted title:', {
            title,
            titleLength: title?.length || 0
        });

        return title ? title.substring(0, 50) : null;
    } catch (error) {
        console.error('Error generating message context title:', {
            error: error.message,
            status: error.status,
            code: error.code,
            promptId: PROMPT_ID_BOT,
            promptVersion: PROMPT_VERSION_BOT
        });
        return null;
    }
}

const findAllMessages = async (chat_id, user) => {
    const { data: chat, error: chatError } = await supabase
        .from('chats')
        .select('*')
        .eq('chat_id', chat_id)
        .eq('user_id', user.id)
        .single();

    if (chatError || !chat) {
        throw new ApiError(httpStatus.FORBIDDEN, "Invalid Chat!");
    }

    const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chat_id)
        .order('created_at', { ascending: true });

    if (msgError) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to fetch messages: ${msgError.message}`);
    }

    return messages || [];
};

const sendFirstMessage = async ({ message, instruction_token, lesson_context, chat_mode = 'arcoai', model = 'arco', user, req, res }) => {
    res.writeHead(200, { "Content-type": "text/plain" });

    const abortController = new AbortController();
    let responseEnded = false;
    let conversationId = null;
    let chatId = null;
    let assistantMessage = '';
    let responseId = null;
    let itemId = null;

    const handleAbort = async () => {
        if (responseEnded) return;
        abortController.abort();
        
        try {
            if (!res.writableEnded && !responseEnded) {
                responseEnded = true;
                res.end();
            }
        } catch (err) {
            console.error("Error ending the response after abort:", err);
        }
    };

    req.on("aborted", handleAbort);
    res.on("close", handleAbort);
    res.on("error", (err) => console.error("Response error:", err));

    // Initialize brief for first message and hoist variables for finally block access
    const initialBrief = {
        summary: {
            goal: "",
            constraints: [],
            decisions: [],
            open_q: [],
            techniques: [],
            lesson_context: lesson_context?.type || ""
        },
        memory_cards: [],
        initial_outline: ""
    };
    let assistantMessageClean = "";
    let capturedCard = null;

    // Create stateful filter for this request
    const filter = createMemoryCardFilter();

    // Helper function to write sanitized UI and accumulate clean text
    const writeUI = (ui) => {
        if (!ui) return;
        // Optional guard to detect any leaks
        if (/<MEMORY_CARD>/.test(ui)) {
            console.error("SANITIZER FAIL: tag reached UI chunk");
        }
        const sanitizedEvent = JSON.stringify({
            event: 'content.delta',
            data: {
                id: 'response',
                text: ui
            }
        }) + '\n';
        res.write(sanitizedEvent);
        assistantMessageClean += ui;
    };

    try {
        // Create chat with first message using Responses API (conversation)
        const { chat, conversation_id, isReusedChat } = await createChatWithFirstMessage(user, message, instruction_token, chat_mode);
        chatId = chat.chat_id;
        conversationId = conversation_id;
        
        // Send the chat info to frontend first, include reuse flag
        const chatCreatedEvent = {
            type: 'chat_created',
            chat,
            isReusedChat: isReusedChat || false
        };
        res.write(JSON.stringify(chatCreatedEvent) + '\n');

        // Generate AI title ASYNCHRONOUSLY (don't block response) if this is a new chat with "New Chat" title
        if (chat.title === "New Chat") {
            // Fire-and-forget async title generation to avoid blocking response
            getMessageContext(message).then(async (title) => {
                if (title) {
                    try {
                        // Always update the database regardless of response stream status
                        await supabase
                            .from('chats')
                            .update({ title })
                            .eq('chat_id', chat.chat_id);

                        console.log("Generated chat title:", title);

                        // Only send event if response stream is still open
                        if (!res.writableEnded && !responseEnded) {
                            const titleUpdateEvent = {
                                type: 'chat_title_updated',
                                chat_id: chat.chat_id,
                                title: title
                            };
                            res.write(JSON.stringify(titleUpdateEvent) + '\n');
                        } else {
                            console.log("Title generated but response stream closed - title saved to database");
                        }
                    } catch (error) {
                        console.error("Title update error in sendFirstMessage:", error);
                    }
                }
            }).catch(error => {
                console.error("Title generation error in sendFirstMessage:", error);
                // Continue even if title generation fails
            });
        }

        const normalizedModel = typeof model === 'string' ? model.toLowerCase().trim() : 'arco';
        let modelVariant = normalizedModel === 'arco-pro' ? 'arco-pro' : 'arco';
        if (model && modelVariant === 'arco' && normalizedModel !== 'arco') {
            console.warn(`[DeepThink] Unsupported model variant "${model}" received for first message, defaulting to "arco"`);
        }
        const isDeepThink = modelVariant === 'arco-pro';

        const userMessageContent = `${message} ${instruction_token}`;
        const userDisplayContent = message; // Clean message for display
        
        console.log('[Backend sendFirstMessage] Prepared user input:', {
            originalMessage: message,
            instructionToken: instruction_token || '(empty)',
            instructionTokenLength: instruction_token ? instruction_token.length : 0,
            finalPrompt: userMessageContent,
            finalPromptLength: userMessageContent.length,
            hasLessonContext: !!lesson_context,
            chatMode: chat_mode,
            modelVariant,
        });

        // Save user message to database first
        const { data: userMsg, error: msgError } = await supabase
            .from('messages')
            .insert({
                role: 'user',
                content: userDisplayContent,
                chat_id: chatId,
                user_id: user.id,
                lesson_context: lesson_context || null,
            })
            .select()
            .single();

        if (msgError) {
            throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to save user message: ${msgError.message}`);
        }

        // Build input with MEMORY_INSTRUCTION for first message
        const contextualSegments = [
            userMessageContent,
            MEMORY_INSTRUCTION
        ];

        let contextualInput = contextualSegments.join('\n\n');

        let promptId = PROMPT_ID;
        let promptVersion = PROMPT_VERSION;
        let promptInstructions = PROMPT_INSTRUCTIONS;
        let vectorSearchResults = [];

        if (chat_mode === 'personal_lessons') {
            promptId = PROMPT_ID_PERSONAL_LESSONS;
            promptVersion = PROMPT_VERSION_PERSONAL_LESSONS;
            promptInstructions = PROMPT_INSTRUCTIONS_PERSONAL_LESSONS;

            vectorSearchResults = await searchVectorStore(user.id, userDisplayContent, 5);

            if (vectorSearchResults.length > 0) {
                const formatted = vectorSearchResults.map((result, index) => {
                    const attributes = result.attributes || {};
                    const title = attributes.title || attributes.lesson_title || attributes.name || `Source ${index + 1}`;
                    const lessonId = attributes.lesson_id || attributes.lessonId;
                    const date = attributes.date || attributes.lesson_date;

                    const rawContentArray = Array.isArray(result.content) ? result.content : [];
                    const extractedText = rawContentArray
                        .map((chunk) => chunk?.text || chunk?.value || '')
                        .filter(Boolean)
                        .join('\n');

                    const fallbackText = typeof result.content === 'string' ? result.content : '';
                    const combinedText = (extractedText || fallbackText || '[No excerpt available]').trim();
                    const truncatedText = combinedText.length > 600 ? `${combinedText.substring(0, 600)}…` : combinedText;

                    const headerParts = [title];
                    if (lessonId) headerParts.push(`ID: ${lessonId}`);
                    if (date) headerParts.push(`Date: ${date}`);

                    return `${headerParts.join(' • ')}\n${truncatedText}`;
                }).join('\n\n');

                contextualSegments.splice(1, 0, `Relevant lesson excerpts:\n${formatted}`);
                contextualInput = contextualSegments.join('\n\n');
            } else {
                console.log(`[VectorStore] No personal lesson matches found for user ${user.id} (new chat ${chatId})`);
            }

            if (isDeepThink) {
                const deepDivePromptId = PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE || PROMPT_ID_DEEPTHINK;
                if (deepDivePromptId) {
                    promptId = deepDivePromptId;
                }

                if (deepDivePromptId === PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE) {
                    promptVersion = PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE || promptVersion;
                    promptInstructions = PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE || promptInstructions;
                } else {
                    promptVersion = PROMPT_VERSION_DEEPTHINK || promptVersion;
                    promptInstructions = PROMPT_INSTRUCTIONS_DEEPTHINK || promptInstructions;
                }
            }
        } else if (isDeepThink) {
            promptId = PROMPT_ID_DEEPTHINK || PROMPT_ID;
            promptVersion = PROMPT_VERSION_DEEPTHINK || PROMPT_VERSION;
            promptInstructions = PROMPT_INSTRUCTIONS_DEEPTHINK || promptInstructions;
        }

        const metadataPayload = {
            model_variant: modelVariant,
            ...(lesson_context ? { lesson_context: JSON.stringify(lesson_context) } : {})
        };

        let responseOptions;

        if (chat_mode === 'personal_lessons') {
            const promptReference = promptId ? { id: promptId } : null;
            if (promptReference && promptVersion) {
                promptReference.version = promptVersion;
            }

            const overrideInstructions = (promptInstructions || '').trim();
            const personalInput = overrideInstructions
                ? `${overrideInstructions}\n\n${contextualInput}`
                : contextualInput;

            console.log('[OpenAI API] About to call with MEMORY instruction (first message):', {
                chatMode: chat_mode,
                modelVariant,
                prompt_id: promptId,
                version: promptVersion,
                inputLength: personalInput.length,
                retrievalMode: `manual_lookup:${vectorSearchResults.length}`,
                usingPromptReference: !!promptReference
            });

            responseOptions = {
                model: OPENAI_MODEL,
                input: personalInput,
                stream: true,
                store: true,
                include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
                text: { format: { type: 'text' } },
                reasoning: { effort: 'low', summary: 'auto' },
                metadata: metadataPayload
            };

            if (promptReference) {
                responseOptions.prompt = promptReference;
            }
        } else {
            console.log('[OpenAI API] About to call with MEMORY instruction (first message):', {
                chatMode: chat_mode,
                modelVariant,
                prompt_id: promptId,
                version: promptVersion,
                inputLength: contextualInput.length,
                retrievalMode: 'prompt_reference'
            });

            responseOptions = {
                prompt: {
                    id: promptId,
                    version: promptVersion
                },
                input: contextualInput,
                stream: true,
                store: true,
                include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
                text: { format: { type: 'text' } },
                reasoning: { effort: 'low', summary: 'auto' },
                metadata: metadataPayload
            };
        }

        const responseStream = await openaiClient.responses.create(responseOptions);

        // Process streaming response
        let isFirstEvent = true;
        for await (const event of responseStream) {
            if (res.writableEnded || abortController.signal.aborted) break;

            // Log the first event to see what we're actually getting
            if (isFirstEvent) {
                console.log('[OpenAI API] First response event received:', {
                    eventType: event.type || event.event,
                    eventKeys: Object.keys(event),
                    promptUsed: event.prompt_id || event.prompt?.id || 'unknown',
                    versionUsed: event.prompt_version || event.prompt?.version || 'unknown'
                });
                isFirstEvent = false;
            }

            // Process events by type with stateful filtering
            const eventType = event.type || event.event;

            if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                // Delta events: process through stateful filter
                const rawText = getTextDelta(event);
                const { ui, card } = filter.feed(rawText);

                if (ui) writeUI(ui);
                if (card && !capturedCard) capturedCard = card;
                continue;  // DO NOT also write the raw delta event

            } else if (eventType === 'response.created' || eventType === 'response.started') {
                // Created/Started events: forward as-is
                responseId = event.response?.id || event.id;
                const eventData = formatResponseEventForFrontend(event);
                if (eventData) res.write(eventData);

            } else if (eventType === 'response.completed' || eventType === 'response.done') {
                // Never forward model text from completed; sanitize if present
                const safe = { ...event };
                if (safe.response?.output_text) {
                    safe.response.output_text.delta = "";
                    safe.response.output_text.text = "";
                    safe.response.output_text.final = "";
                }
                const eventData = formatResponseEventForFrontend(safe);
                if (eventData) res.write(eventData);

            } else {
                // Forward non-text events as-is
                const eventData = formatResponseEventForFrontend(event);
                if (eventData) res.write(eventData);
            }
        }

        // Flush leftover UI tail after stream ends
        const tail = filter.flush();
        if (tail.ui) writeUI(tail.ui);

    } catch (error) {
        console.error("Error in sendFirstMessage:", error);
        
        // Determine error type and create appropriate response
        let errorMessage = error.message;
        let errorCode = 'UNKNOWN_ERROR';
        
        if (error.status === 400) {
            errorCode = 'BAD_REQUEST';
            // For OpenAI API errors, use the specific error message
            errorMessage = error.message || 'Invalid request. Please check your message and try again.';
        } else if (error.status === 401) {
            errorCode = 'UNAUTHORIZED';
            errorMessage = error.message || 'Authentication failed. Please check your API configuration.';
        } else if (error.status === 402) {
            errorCode = 'QUOTA_EXCEEDED';
            errorMessage = error.message || 'API quota exceeded. Please try again later.';
        } else if (error.status === 429) {
            errorCode = 'RATE_LIMITED';
            errorMessage = error.message || 'Too many requests. Please slow down and try again.';
        } else if (error.status >= 500) {
            errorCode = 'SERVER_ERROR';
            errorMessage = error.message || 'Server error occurred. Please try again.';
        } else if (error.code === 'ECONNABORTED') {
            errorCode = 'TIMEOUT';
            errorMessage = 'Request timed out. Please try again.';
        } else if (error.name === 'AbortError') {
            errorCode = 'ABORTED';
            errorMessage = 'Request was cancelled.';
        }
        
        // Send structured error to frontend
        const errorEvent = JSON.stringify({
            event: 'error',
            data: { 
                message: errorMessage,
                code: errorCode,
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            }
        }) + '\n';
        
        if (!res.writableEnded) {
            res.write(errorEvent);
        }
    } finally {
        // Save assistant message and initialize conversation context
        if (assistantMessageClean && !abortController.signal.aborted) {
            try {
                let outline = "";
                let nextBrief = initialBrief;

                // Process captured MEMORY_CARD for initial brief creation
                if (capturedCard) {
                    try {
                        const memoryCard = JSON.parse(capturedCard);
                        nextBrief = updateBrief(initialBrief, memoryCard);
                        console.log('[First Message] Brief created with token count:', approxTokens(toWire(nextBrief)));
                    } catch (parseError) {
                        console.error('[MEMORY_CARD] Parse error on first message, saving default brief:', parseError, {
                            cardPreview: capturedCard.slice(0, 200)
                        });
                        nextBrief = initialBrief;
                    }
                } else {
                    // No MEMORY_CARD found, keep default brief
                    console.log('[First Message] No MEMORY_CARD found, using default brief');
                }

                // Final safety scrub before database storage (paranoia-level)
                assistantMessageClean = assistantMessageClean.replace(/<MEMORY_CARD>[\s\S]*?<\/MEMORY_CARD>\s*$/g, '');

                // Generate outline for next turn from clean text
                outline = generateOutline(assistantMessageClean);

                if (!nextBrief.initial_outline) {
                    nextBrief = {
                        ...nextBrief,
                        initial_outline: outline,
                    };
                }

                try {
                    await saveBrief(chatId, user.id, nextBrief);
                } catch (briefError) {
                    console.error('[First Message] Failed to persist brief:', briefError);
                }

                // Save assistant message with outline and mark as initial
                const { error: saveError } = await supabase
                    .from('messages')
                    .insert({
                        role: 'assistant',
                        content: assistantMessageClean,
                        outline: outline,
                        is_initial: true, // Mark first assistant response
                        chat_id: chatId,
                        user_id: user.id,
                        response_id: responseId,
                        item_id: itemId,
                    });

                if (saveError) {
                    console.error("Error saving assistant message:", saveError);
                }
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

module.exports = { sendMessage, findAllMessages, sendFirstMessage };
