const { openaiClient, PROMPT_ID, PROMPT_VERSION } = require("../config/openai.js");
const { supabase } = require("../config/supabase.js");
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

const createChat = async (user, title = null) => {
    // Generate conversation ID locally - conversations are created implicitly in Responses API
    const { v4: uuidv4 } = require('uuid');
    const conversationId = uuidv4();
    
    const { data: chatData, error } = await supabase
        .from('chats')
        .insert({
            conversation_id: conversationId,
            thread_id: conversationId, // Keep for backward compatibility during migration
            prompt_id: PROMPT_ID,
            user_id: user.id,
            title: title || "New Chat",
        })
        .select()
        .single();

    if (error) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to create chat: ${error.message}`);
    }

    // Don't expose internal IDs to frontend
    const chat = { ...chatData };
    delete chat.thread_id;
    delete chat.conversation_id;
    return chat;
};

const updateChat = async (user, chat_id, title) => {
    const { data: chatData, error: fetchError } = await supabase
        .from('chats')
        .select('*')
        .eq('chat_id', chat_id)
        .eq('user_id', user.id)
        .single();

    if (fetchError || !chatData) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Invalid Chat!");
    }

    const { data: updatedChat, error: updateError } = await supabase
        .from('chats')
        .update({ title })
        .eq('chat_id', chat_id)
        .eq('user_id', user.id)
        .select()
        .single();

    if (updateError) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to update chat: ${updateError.message}`);
    }

    // Clean up response for frontend
    const chat = { ...updatedChat };
    delete chat.thread_id;
    delete chat.conversation_id;
    return chat;
};

const getAllChats = async (user) => {
    const { data: chats, error } = await supabase
        .from('chats')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

    if (error) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to fetch chats: ${error.message}`);
    }

    return chats || [];
};

const deleteChat = async (user, chat_id) => {
    if (!chat_id) {
        throw new ApiError(httpStatus.BAD_REQUEST, "chat_id is required!");
    }
    
    const { data: chatData, error: fetchError } = await supabase
        .from('chats')
        .select('*')
        .eq('chat_id', chat_id)
        .eq('user_id', user.id)
        .single();

    if (fetchError || !chatData) {
        throw new ApiError(httpStatus.FORBIDDEN, "Invalid chat!");
    }
    
    // Note: Responses API conversations are managed implicitly
    // No explicit deletion needed - they are cleaned up automatically by OpenAI
    // Just delete the Supabase chat record
    
    const { error: deleteError } = await supabase
        .from('chats')
        .delete()
        .eq('chat_id', chat_id)
        .eq('user_id', user.id);

    if (deleteError) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to delete chat: ${deleteError.message}`);
    }
};

/**
 * Create chat with first message, with special handling for prep digest reuse
 * 
 * Flow for prep digest messages:
 * 1. Detect prep digest pattern in message content
 * 2. Extract student name from "Prep digest for {studentName}"
 * 3. Search for existing prep digest chat with exact title match
 * 4. If found: Clear existing messages and reuse the chat
 * 5. If not found: Create new chat with predictable title
 * 
 * Flow for regular messages:
 * 1. Generate title from message content (truncated intelligently)
 * 2. Create new chat with generated title
 * 
 * @param {Object} user - User object with id
 * @param {string} message - The first message content
 * @param {string} instruction_token - Optional instruction token to append
 * @returns {Object} Chat creation result with conversation_id and isReusedChat flag
 */
const createChatWithFirstMessage = async (user, message, instruction_token = '') => {
    try {
        // Extract clean message without instruction token for title generation
        let cleanMessage = message;
        if (instruction_token && message.includes(instruction_token)) {
            cleanMessage = message.replace(instruction_token, '').trim();
        }
        
        // Check if this is a prep digest message
        // Pattern matches "Prep digest for {studentName}" at the start of a line (excluding newlines from student name)
        const prepDigestPattern = /^Prep digest for ([^\n]+)$/m;
        const prepMatch = cleanMessage.match(prepDigestPattern);
        
        if (prepMatch) {
            // This is a prep digest message - check for existing chat
            const studentName = prepMatch[1].trim();
            console.log('[DEBUG] Prep digest detected:', {
                studentName,
                matchedPattern: prepMatch[0],
                fullMessage: cleanMessage.substring(0, 100) + '...'
            });
            
            if (!studentName) {
                console.error('Empty student name in prep digest message');
                throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid prep digest message: missing student name');
            }
            
            const existingChat = await findPrepDigestChat(user, studentName);
            
            if (existingChat) {
                // Reuse existing prep digest chat
                console.log(`Reusing existing prep digest chat for ${studentName}:`, existingChat.chat_id);
                
                // Clear existing messages from this chat
                // Note: This is safe to do repeatedly - if no messages exist, the operation is a no-op
                await clearChatMessages(existingChat.chat_id, user.id);
                
                // Update the chat's updated_at timestamp to move it to the top of the chat list
                const { error: timestampError } = await supabase
                    .from('chats')
                    .update({ updated_at: new Date().toISOString() })
                    .eq('chat_id', existingChat.chat_id)
                    .eq('user_id', user.id);
                
                if (timestampError) {
                    console.error('Error updating timestamp for reused prep chat:', timestampError);
                    // Continue anyway - the reuse will still work, just won't move to top
                }
                
                // Ensure conversation_id exists (for legacy chats)
                let conversationId = existingChat.conversation_id;
                if (!conversationId) {
                    // Generate a new conversation_id for legacy chats
                    const { v4: uuidv4 } = require('uuid');
                    conversationId = uuidv4();
                    
                    // Update the chat with the new conversation_id
                    const { error: updateError } = await supabase
                        .from('chats')
                        .update({ conversation_id: conversationId })
                        .eq('chat_id', existingChat.chat_id)
                        .eq('user_id', user.id);
                    
                    if (updateError) {
                        console.error('Error updating conversation_id for legacy chat:', updateError);
                        // For legacy chats without conversation_id, we'll use the existing thread_id as fallback
                        conversationId = existingChat.thread_id || conversationId;
                    }
                }
                
                // Return the existing chat info with its conversation_id
                const chat = { ...existingChat };
                // Don't expose internal IDs to frontend
                delete chat.thread_id;
                delete chat.conversation_id;
                
                return { 
                    chat, 
                    conversation_id: conversationId,
                    // Keep thread_id for backward compatibility during migration
                    thread_id: conversationId,
                    isReusedChat: true
                };
            }
            // If no existing prep chat found, continue to create new one with predictable title
        }
        
        // Determine initial title - use "New Chat" to trigger AI title generation
        let title;

        // Special handling for prep digest titles - these get explicit titles immediately
        if (prepMatch) {
            title = `Prep digest for ${prepMatch[1].trim()}`;
            console.log('[DEBUG] Generated prep digest title:', title);
        } else {
            // For regular chats, start with "New Chat" so AI title generation can trigger
            title = "New Chat";
            console.log('[DEBUG] Created chat with "New Chat" title to trigger AI generation');
        }
        
        // Generate conversation ID locally - conversations are created implicitly in Responses API
        const { v4: uuidv4 } = require('uuid');
        const conversationId = uuidv4();
        
        // Create chat in database
        const { data: chatData, error } = await supabase
            .from('chats')
            .insert({
                conversation_id: conversationId,
                thread_id: conversationId, // Keep for backward compatibility
                prompt_id: PROMPT_ID,
                user_id: user.id,
                title,
            })
            .select()
            .single();

        if (error) {
            throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to create chat: ${error.message}`);
        }
        
        const chat = { ...chatData };
        // Don't expose internal IDs to frontend
        delete chat.thread_id;
        delete chat.conversation_id;
        
        // Return both chat object and conversation_id for message service
        return { 
            chat, 
            conversation_id: conversationId,
            // Keep thread_id for backward compatibility during migration
            thread_id: conversationId 
        };
    } catch (error) {
        console.error('Error creating chat with first message:', error);
        throw error;
    }
};

/**
 * Find existing prep digest chat for a user by student name
 * @param {Object} user - User object
 * @param {string} studentName - Name of the student
 * @returns {Object|null} Existing prep chat or null if not found
 */
const findPrepDigestChat = async (user, studentName) => {
    if (!user || !user.id || !studentName) {
        console.error('Invalid parameters for findPrepDigestChat:', { user: !!user, userId: user?.id, studentName });
        return null;
    }
    
    const prepTitle = `Prep digest for ${studentName}`;
    
    try {
        const { data: chats, error } = await supabase
            .from('chats')
            .select('*')
            .eq('user_id', user.id)
            .eq('title', prepTitle)
            .order('created_at', { ascending: false })
            .limit(1);
        
        if (error) {
            console.error('Database error finding prep digest chat:', error);
            return null;
        }
        
        if (chats && chats.length > 1) {
            // Multiple prep digest chats found - this shouldn't happen but let's handle it
            console.warn(`Found ${chats.length} prep digest chats for ${studentName}. Using most recent.`);
        }
        
        return chats && chats.length > 0 ? chats[0] : null;
    } catch (error) {
        console.error('Unexpected error finding prep digest chat:', error);
        return null;
    }
};

/**
 * Clear all messages from a chat
 * @param {string} chatId - The chat ID
 * @param {string} userId - The user ID (for security)
 * @returns {boolean} Success status
 */
const clearChatMessages = async (chatId, userId) => {
    if (!chatId || !userId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Chat ID and User ID are required');
    }
    
    try {
        // Verify chat belongs to user first
        const { data: chat, error: chatError } = await supabase
            .from('chats')
            .select('chat_id')
            .eq('chat_id', chatId)
            .eq('user_id', userId)
            .single();
        
        if (chatError || !chat) {
            throw new ApiError(httpStatus.FORBIDDEN, 'Chat not found or access denied');
        }
        
        // Delete all messages for this chat
        const { error: deleteError } = await supabase
            .from('messages')
            .delete()
            .eq('chat_id', chatId)
            .eq('user_id', userId);
        
        if (deleteError) {
            throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to clear messages: ${deleteError.message}`);
        }
        
        console.log(`Cleared all messages from chat ${chatId} for user ${userId}`);
        return true;
    } catch (error) {
        if (error.status) {
            // Re-throw ApiError as-is
            throw error;
        }
        // Wrap unexpected errors
        console.error('Unexpected error clearing chat messages:', error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Unexpected error clearing messages: ${error.message}`);
    }
};

module.exports = { createChat, updateChat, getAllChats, deleteChat, createChatWithFirstMessage, findPrepDigestChat, clearChatMessages };
