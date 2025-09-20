const { supabase } = require("../config/supabase.js");
const { openaiClient, PROMPT_ID, PROMPT_VERSION, botClient, PROMPT_ID_BOT, PROMPT_VERSION_BOT } = require("../config/openai");
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const { createChatWithFirstMessage } = require('./chat.service');


// Format Responses API streaming events for frontend compatibility
const formatResponseEventForFrontend = (responseEvent) => {
    // Debug logging removed - was causing excessive console output
    // console.log('[Responses API] Raw event:', JSON.stringify(responseEvent, null, 2));
    
    // Map Responses API streaming events to expected frontend format
    // The actual event structure may be different, so we handle both possible formats
    const eventType = responseEvent.type || responseEvent.event;
    
    switch(eventType) {
        case 'response.output_text.delta':
        case 'output_text.delta':
        case 'content.delta':
            // Map content delta to expected format
            return JSON.stringify({
                event: 'content.delta',
                data: {
                    id: responseEvent.response?.id || responseEvent.id || 'response',
                    text: responseEvent.delta || responseEvent.text || responseEvent.content || ''
                }
            }) + '\n';

            
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

const sendMessage = async ({ message, chat_id, instruction_token, lesson_context, user, req, res }) => {
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

        const userMessageContent = `${message} ${instruction_token}`;
        const userDisplayContent = message; // Clean message for display
        
        console.log('[Backend sendMessage] OpenAI Input Prompt:', {
            originalMessage: message,
            instructionToken: instruction_token || '(empty)',
            instructionTokenLength: instruction_token ? instruction_token.length : 0,
            finalPrompt: userMessageContent,
            finalPromptLength: userMessageContent.length,
            hasLessonContext: !!lesson_context,
            promptId: PROMPT_ID,
            promptVersion: PROMPT_VERSION
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

        // Create response using Responses API (OpenAI SDK 5.x)
        console.log('[OpenAI API] About to call with FIXED prompt structure:', {
            prompt_id: PROMPT_ID,
            version: PROMPT_VERSION,
            inputLength: userMessageContent.length
        });
        
        const responseStream = await openaiClient.responses.create({
            prompt: {
                id: PROMPT_ID,
                version: PROMPT_VERSION
            },
            input: userMessageContent,
            stream: true,
            // Pass lesson context as metadata if provided
            ...(lesson_context && { 
                metadata: { 
                    lesson_context: JSON.stringify(lesson_context) 
                } 
            })
        });

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

            // Forward Responses API events directly to frontend
            const eventData = formatResponseEventForFrontend(event);
            
            if (eventData) {
                res.write(eventData);
                
                // Accumulate data for database storage
                const eventType = event.type || event.event;
                if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                    assistantMessage += event.delta || event.text || event.content || '';
                } else if (eventType === 'response.created' || eventType === 'response.started') {
                    responseId = event.response?.id || event.id;
                } else if (eventType === 'response.completed' || eventType === 'response.done') {
                    // Response completed - we have all the data
                    if (event.response?.output?.length > 0) {
                        // Get the full text from completed response if we don't have it
                        const fullText = event.response.output.map(item => 
                            item.content?.[0]?.text || item.content || item.text || ''
                        ).join('');
                        if (fullText && !assistantMessage) {
                            assistantMessage = fullText;
                        }
                    } else if (event.output_text && !assistantMessage) {
                        // Use output_text if available
                        assistantMessage = event.output_text;
                    }
                }
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
        // Save assistant message to database
        if (assistantMessage && !abortController.signal.aborted) {
            try {
                const { error: saveError } = await supabase
                    .from('messages')
                    .insert({
                        role: 'assistant',
                        content: assistantMessage,
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

const sendFirstMessage = async ({ message, instruction_token, lesson_context, user, req, res }) => {
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

    try {
        // Create chat with first message using Responses API (conversation)
        const { chat, conversation_id, isReusedChat } = await createChatWithFirstMessage(user, message, instruction_token);
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

        const userMessageContent = `${message} ${instruction_token}`;
        const userDisplayContent = message; // Clean message for display
        
        console.log('[Backend sendFirstMessage] OpenAI Input Prompt:', {
            originalMessage: message,
            instructionToken: instruction_token || '(empty)',
            instructionTokenLength: instruction_token ? instruction_token.length : 0,
            finalPrompt: userMessageContent,
            finalPromptLength: userMessageContent.length,
            hasLessonContext: !!lesson_context,
            promptId: PROMPT_ID,
            promptVersion: PROMPT_VERSION
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

        // Create response using Responses API (OpenAI SDK 5.x)
        console.log('[OpenAI API] About to call with FIXED prompt structure:', {
            prompt_id: PROMPT_ID,
            version: PROMPT_VERSION,
            inputLength: userMessageContent.length
        });
        
        const responseStream = await openaiClient.responses.create({
            prompt: {
                id: PROMPT_ID,
                version: PROMPT_VERSION
            },
            input: userMessageContent,
            stream: true,
            // Pass lesson context as metadata if provided
            ...(lesson_context && { 
                metadata: { 
                    lesson_context: JSON.stringify(lesson_context) 
                } 
            })
        });

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

            // Forward Responses API events directly to frontend
            const eventData = formatResponseEventForFrontend(event);
            
            if (eventData) {
                res.write(eventData);
                
                // Accumulate data for database storage
                const eventType = event.type || event.event;
                if (eventType === 'response.output_text.delta' || eventType === 'output_text.delta' || eventType === 'content.delta') {
                    assistantMessage += event.delta || event.text || event.content || '';
                } else if (eventType === 'response.created' || eventType === 'response.started') {
                    responseId = event.response?.id || event.id;
                } else if (eventType === 'response.completed' || eventType === 'response.done') {
                    // Response completed - we have all the data
                    if (event.response?.output?.length > 0) {
                        // Get the full text from completed response if we don't have it
                        const fullText = event.response.output.map(item => 
                            item.content?.[0]?.text || item.content || item.text || ''
                        ).join('');
                        if (fullText && !assistantMessage) {
                            assistantMessage = fullText;
                        }
                    } else if (event.output_text && !assistantMessage) {
                        // Use output_text if available
                        assistantMessage = event.output_text;
                    }
                }
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
        // Save assistant message to database
        if (assistantMessage && !abortController.signal.aborted) {
            try {
                const { error: saveError } = await supabase
                    .from('messages')
                    .insert({
                        role: 'assistant',
                        content: assistantMessage,
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
