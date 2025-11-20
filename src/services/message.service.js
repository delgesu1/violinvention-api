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
    PROMPT_ID_LESSON_PLAN,
    PROMPT_VERSION_LESSON_PLAN,
    PROMPT_INSTRUCTIONS_LESSON_PLAN,
    OPENAI_MODEL,
    botClient,
    PROMPT_ID_BOT,
    PROMPT_VERSION_BOT
} = require("../config/openai");
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const { createChatWithFirstMessage } = require('./chat.service');
const { buildMemoryContext, maybeUpdateGlobalSummary, approxTokens, DEFAULT_MEMORY_STATE, saveConversationMemory } = require('./conversationMemory.service');
const { logLLMInput, logLLMOutput } = require('../utils/llmLogger');
const { searchVectorStore } = require('./vectorStore.service');

// Helper function to strip citation markers from OpenAI responses
const stripCitations = (text) => {
    if (!text) return text;

    // Remove OpenAI citation patterns like: 【citation】, filecite, turn0file5, etc.
    // These patterns include unicode private use area characters and citation markers
    return text
        // Remove 【...】 style citations
        .replace(/【[^】]*】/g, '')
        // Remove filecite markers with turn/file references
        .replace(/[\uE000-\uF8FF]?filecite[\uE000-\uF8FF]?turn\d+file\d+[\uE000-\uF8FF]?/g, '')
        // Remove any remaining private use area characters (often used for citations)
        .replace(/[\uE000-\uF8FF]/g, '');
};

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
    let memoryBrief = { ...DEFAULT_MEMORY_STATE };
    let memoryContext = null;
    let assistantMessageClean = "";
    let modelVariant = 'arco';

    // Helper function to write sanitized UI and accumulate clean text
    const writeUI = (ui) => {
        if (!ui) return;
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
        modelVariant = normalizedModel === 'arco-pro' ? 'arco-pro' : 'arco';
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

        // LOAD CONVERSATION MEMORY CONTEXT
        let memoryBlock = "";
        try {
            memoryContext = await buildMemoryContext({
                chatId: chat_id,
                userId: user.id,
                excludeMessageIds: userMsg?.message_id ? [userMsg.message_id] : [],
            });
            memoryBrief = memoryContext.brief || { ...DEFAULT_MEMORY_STATE };
            memoryBlock = memoryContext.memoryText || "";

            console.log('[Conversation Memory] Block tokens:', approxTokens(memoryBlock));
            console.log('[Conversation Memory] Tail turns:', memoryContext?.tailTurns?.length || 0, 'Dropped:', memoryContext?.droppedTailTurns || 0, 'Chunk tokens:', memoryContext?.chunkTokenCount || 0);
        } catch (memoryError) {
            console.error('[Conversation Memory] Failed to build context, continuing without memory block:', memoryError);
            memoryBrief = { ...DEFAULT_MEMORY_STATE };
            memoryContext = null;
            memoryBlock = "";
        }

        // BUILD INPUT WITH CONVERSATION CONTEXT
        const segments = [];
        if (memoryBlock) {
            segments.push(memoryBlock);
        }

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
            segments.push(retrievalContext);
        }

        segments.push(userMessageContent);

        const contextualInput = segments.filter(Boolean).join('\n\n');

        const inputMetadata = {
            chat_id,
            prompt_id: promptId,
            prompt_version: promptVersion,
            chat_mode: chatMode,
            model_variant: modelVariant,
        };
        logLLMInput('sendMessage.main', contextualInput, inputMetadata);

        console.log('[Conversation Context] Memory tokens:', approxTokens(memoryBlock));
        console.log('[Conversation Context] Total context tokens:', approxTokens(contextualInput));

        const metadataPayload = {
            model_variant: modelVariant,
            ...(lesson_context ? { lesson_context: JSON.stringify(lesson_context) } : {}),
            ...(lesson_plan_prompt ? { lesson_plan_prompt: true } : {})
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

            const promptRef = { id: promptId };
            if (promptVersion) {
                promptRef.version = promptVersion;
            }

            responseOptions = {
                prompt: promptRef,
                input: contextualInput,
                stream: true,
                store: true,
                include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
                text: { format: { type: 'text' } },
                reasoning: { effort: 'low', summary: 'auto' },
                metadata: metadataPayload
            };
        }

        // Log full input being sent to OpenAI for debugging
        console.log('[OpenAI API] Full input being sent:', {
            promptId,
            promptVersion,
            fullInput: contextualInput,
            inputCharCount: contextualInput.length,
            inputTokenApprox: approxTokens(contextualInput)
        });

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

            // Process events by type
            const eventType = event.type || event.event;

            if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                // Delta events: strip citations and stream to UI
                const rawText = stripCitations(getTextDelta(event));
                if (rawText) {
                    writeUI(rawText);
                }
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
        // Save assistant message and kick off background summarization
        if (assistantMessageClean && !abortController.signal.aborted) {
            try {
                const assistantPayload = {
                    role: 'assistant',
                    content: assistantMessageClean,
                    chat_id,
                    user_id: user.id,
                    response_id: responseId,
                    item_id: itemId,
                    metadata: {
                        model_variant: modelVariant,
                    },
                };

                logLLMOutput('sendMessage.main', assistantMessageClean, {
                    chat_id,
                    model_variant: modelVariant,
                    response_id: responseId,
                    item_id: itemId,
                });

                const { error: saveError } = await supabase
                    .from('messages')
                    .insert(assistantPayload);

                if (saveError) {
                    console.error("Error saving assistant message:", saveError);
                } else if (memoryBrief) {
                    maybeUpdateGlobalSummary({ chatId: chat_id, userId: user.id, brief: memoryBrief })
                        .catch((summaryError) => {
                            console.error('[Conversation Memory] Failed to summarize chunk:', summaryError);
                        });
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
        const titlePromptText = `Generate a short, descriptive title (max 50 characters) for this message: "${inputMessage}"`;
        logLLMInput('message.titleGenerator', titlePromptText, {
            prompt_id: PROMPT_ID_BOT,
            prompt_version: PROMPT_VERSION_BOT,
        });

        const response = await botClient.responses.create({
            prompt: {
                id: PROMPT_ID_BOT,
                version: PROMPT_VERSION_BOT
            },
            input: titlePromptText,
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

        if (title) {
            logLLMOutput('message.titleGenerator', title, {
                prompt_id: PROMPT_ID_BOT,
                prompt_version: PROMPT_VERSION_BOT,
            });
        }

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

const sendFirstMessage = async ({ message, instruction_token, lesson_context, chat_mode = 'arcoai', model = 'arco', lesson_plan_prompt = false, user, req, res }) => {
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

    let memoryBrief = { ...DEFAULT_MEMORY_STATE };
    let assistantMessageClean = "";
    let modelVariant = 'arco';

    // Helper function to write sanitized UI and accumulate clean text
    const writeUI = (ui) => {
        if (!ui) return;
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
        const promptOverrideId = lesson_plan_prompt ? PROMPT_ID_LESSON_PLAN : null;
        const { chat, conversation_id, isReusedChat } = await createChatWithFirstMessage(
            user,
            message,
            instruction_token,
            chat_mode,
            promptOverrideId
        );
        chatId = chat.chat_id;
        conversationId = conversation_id;
        
        // Send the chat info to frontend first, include reuse flag
        const chatCreatedEvent = {
            type: 'chat_created',
            chat,
            isReusedChat: isReusedChat || false
        };
        res.write(JSON.stringify(chatCreatedEvent) + '\n');

        if (isReusedChat) {
            try {
                await saveConversationMemory(chatId, user.id, DEFAULT_MEMORY_STATE);
            } catch (memoryResetError) {
                console.error('[Conversation Memory] Failed to reset memory for reused chat:', memoryResetError);
            }
        }

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
        modelVariant = normalizedModel === 'arco-pro' ? 'arco-pro' : 'arco';
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

        let memoryBlock = "";
        try {
            const memoryContext = await buildMemoryContext({
                chatId,
                userId: user.id,
                excludeMessageIds: userMsg?.message_id ? [userMsg.message_id] : [],
            });
            memoryBrief = memoryContext.brief || { ...DEFAULT_MEMORY_STATE };
            memoryBlock = memoryContext.memoryText || "";
            console.log('[Conversation Memory] (first message) Block tokens:', approxTokens(memoryBlock));
        } catch (memoryError) {
            console.error('[Conversation Memory] Failed to prepare first-message context:', memoryError);
            memoryBrief = { ...DEFAULT_MEMORY_STATE };
            memoryBlock = "";
        }

        const contextualSegments = [];
        if (memoryBlock) {
            contextualSegments.push(memoryBlock);
        }

        let promptId = PROMPT_ID;
        let promptVersion = PROMPT_VERSION;
        let promptInstructions = PROMPT_INSTRUCTIONS;
        let vectorSearchResults = [];

        if (lesson_plan_prompt) {
            promptId = PROMPT_ID_LESSON_PLAN || promptId;
            promptVersion = PROMPT_VERSION_LESSON_PLAN || promptVersion;
            promptInstructions = PROMPT_INSTRUCTIONS_LESSON_PLAN || promptInstructions;
        } else if (chat_mode === 'personal_lessons') {
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

                contextualSegments.push(`Relevant lesson excerpts:\n${formatted}`);
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

        contextualSegments.push(userMessageContent);
        const contextualInput = contextualSegments.filter(Boolean).join('\n\n');

        logLLMInput('sendFirstMessage.main', contextualInput, {
            chat_id: chatId,
            prompt_id: promptId,
            prompt_version: promptVersion,
            chat_mode: chat_mode,
            model_variant: modelVariant,
        });

        console.log('[Conversation Context] (first message) Memory tokens:', approxTokens(memoryBlock));
        console.log('[Conversation Context] (first message) Total context tokens:', approxTokens(contextualInput));

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

            console.log('[OpenAI API] About to call with memory context (first message):', {
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
            console.log('[OpenAI API] About to call with memory context (first message):', {
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

        // Log full input being sent to OpenAI for debugging (first message)
        console.log('[OpenAI API] Full input being sent (first message):', {
            promptId,
            promptVersion,
            fullInput: contextualInput,
            inputCharCount: contextualInput.length,
            inputTokenApprox: approxTokens(contextualInput)
        });

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

            // Process events by type
            const eventType = event.type || event.event;

            if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                // Delta events: strip citations and forward to UI
                const rawText = stripCitations(getTextDelta(event));
                if (rawText) {
                    writeUI(rawText);
                }
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
        // Save assistant message and trigger background summarization setup
        if (assistantMessageClean && !abortController.signal.aborted && chatId) {
            try {
                const assistantPayload = {
                    role: 'assistant',
                    content: assistantMessageClean,
                    is_initial: true,
                    chat_id: chatId,
                    user_id: user.id,
                    response_id: responseId,
                    item_id: itemId,
                    metadata: {
                        model_variant: modelVariant,
                    },
                };

                logLLMOutput('sendFirstMessage.main', assistantMessageClean, {
                    chat_id: chatId,
                    model_variant: modelVariant,
                    response_id: responseId,
                    item_id: itemId,
                });

                const { error: saveError } = await supabase
                    .from('messages')
                    .insert(assistantPayload);

                if (saveError) {
                    console.error("Error saving assistant message:", saveError);
                } else if (memoryBrief) {
                    maybeUpdateGlobalSummary({ chatId, userId: user.id, brief: memoryBrief })
                        .catch((summaryError) => {
                            console.error('[Conversation Memory] Failed to summarize chunk (first message):', summaryError);
                        });
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
