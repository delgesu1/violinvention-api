const { openaiClient } = require('../config/openai');
const { supabase } = require('../config/supabase');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

/**
 * VectorStoreService
 * Manages per-user OpenAI vector stores for lesson summaries/transcripts
 * Provides semantic search for chat context
 */

/**
 * Get user's vector store settings from database
 * @param {string} userId - Supabase user ID
 * @returns {Promise<Object|null>} User settings with vector_store_id
 */
const getUserSettings = async (userId) => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = not found, which is OK
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to get user settings: ${error.message}`);
  }

  return data;
};

/**
 * Update user's vector store settings in database
 * @param {string} userId - Supabase user ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated settings
 */
const updateUserSettings = async (userId, updates) => {
  // First, check if user_settings row exists
  const existing = await getUserSettings(userId);

  if (existing) {
    // Update existing row
    const { data, error } = await supabase
      .from('user_settings')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to update user settings: ${error.message}`);
    }

    return data;
  } else {
    // Create new row with defaults
    const { data, error } = await supabase
      .from('user_settings')
      .insert({
        user_id: userId,
        settings_data: {}, // Default empty settings
        ...updates
      })
      .select()
      .single();

    if (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to create user settings: ${error.message}`);
    }

    return data;
  }
};

/**
 * Get or create user's vector store
 * Creates a new vector store if user doesn't have one
 * @param {string} userId - Supabase user ID
 * @returns {Promise<string>} Vector store ID
 */
const ensureVectorStore = async (userId) => {
  // Check if user already has a vector store
  const settings = await getUserSettings(userId);

  if (settings && settings.vector_store_id) {
    return settings.vector_store_id;
  }

  // Create new vector store for user
  const vectorStore = await openaiClient.vectorStores.create({
    name: `user_${userId}_lessons`,
    expires_after: null // Never expires
  });

  // Save to database
  await updateUserSettings(userId, {
    vector_store_id: vectorStore.id,
    vector_store_created_at: new Date().toISOString()
  });

  console.log(`[VectorStore] Created vector store ${vectorStore.id} for user ${userId}`);
  return vectorStore.id;
};

/**
 * Get user's vector store ID (without creating)
 * @param {string} userId - Supabase user ID
 * @returns {Promise<string|null>} Vector store ID or null
 */
const getUserVectorStore = async (userId) => {
  const settings = await getUserSettings(userId);
  return settings?.vector_store_id || null;
};

/**
 * Upload lesson (summary + transcript) to user's vector store
 * @param {string} userId - Supabase user ID
 * @param {string} summary - Lesson summary text
 * @param {string} transcript - Lesson transcript text
 * @param {Object} metadata - Lesson metadata (lesson_id, title, date, student_name, tags)
 * @returns {Promise<{openai_file_id: string, vector_store_file_id: string}>}
 */
const uploadLessonToVectorStore = async (userId, summary, transcript, metadata) => {
  if (!summary || !transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Both summary and transcript are required');
  }

  if (!metadata || !metadata.lesson_id) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Metadata with lesson_id is required');
  }

  // Ensure user has a vector store
  const vectorStoreId = await ensureVectorStore(userId);

  // Create combined file content (summary first for OpenAI chunking priority)
  const combinedContent = `=== LESSON SUMMARY ===
${summary}

=== FULL TRANSCRIPT ===
${transcript}`;

  // Step 1: Upload file to OpenAI Files API (using Buffer for Node.js compatibility)
  const file = await openaiClient.files.create({
    file: await openaiClient.toFile(
      Buffer.from(combinedContent, 'utf-8'),
      `lesson_${metadata.lesson_id}.txt`
    ),
    purpose: 'assistants'
  });

  // Step 2: Add file to vector store with attributes (metadata for filtering/display)
  const vectorStoreFile = await openaiClient.vectorStores.files.create(
    vectorStoreId,
    {
      file_id: file.id,
      attributes: {
        lesson_id: metadata.lesson_id,
        title: metadata.title || '',
        date: metadata.date || '',
        student_name: metadata.student_name || '',
        tags: JSON.stringify(metadata.tags || [])
      },
      chunking_strategy: {
        type: 'auto'
      }
    }
  );

  console.log(`[VectorStore] Uploaded lesson ${metadata.lesson_id} to vector store ${vectorStoreId}`);
  console.log(`[VectorStore] File ID: ${file.id}, Vector Store File ID: ${vectorStoreFile.id}`);

  return {
    openai_file_id: file.id,
    vector_store_file_id: vectorStoreFile.id
  };
};

/**
 * Delete lesson from vector store (both vector store file AND OpenAI file)
 * @param {string} userId - Supabase user ID
 * @param {string} vectorStoreFileId - Vector store file ID
 * @param {string} openaiFileId - OpenAI file ID
 * @returns {Promise<{deleted: boolean}>}
 */
const deleteLessonFromVectorStore = async (userId, vectorStoreFileId, openaiFileId) => {
  if (!vectorStoreFileId || !openaiFileId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Both vectorStoreFileId and openaiFileId are required');
  }

  const vectorStoreId = await getUserVectorStore(userId);

  if (!vectorStoreId) {
    console.warn(`[VectorStore] User ${userId} has no vector store, skipping deletion`);
    return { deleted: false };
  }

  let vectorStoreDeletionSuccess = false;
  let openaiFileDeletionSuccess = false;

  // Step 1: Remove file from vector store
  try {
    await openaiClient.vectorStores.files.del(vectorStoreId, vectorStoreFileId);
    console.log(`[VectorStore] Removed file ${vectorStoreFileId} from vector store ${vectorStoreId}`);
    vectorStoreDeletionSuccess = true;
  } catch (error) {
    console.error(`[VectorStore] Failed to remove file from vector store:`, error.message);
    // Continue to delete OpenAI file even if vector store deletion fails
  }

  // Step 2: Delete underlying OpenAI file (critical for preventing orphaned files)
  try {
    await openaiClient.files.del(openaiFileId);
    console.log(`[VectorStore] Deleted OpenAI file ${openaiFileId}`);
    openaiFileDeletionSuccess = true;
  } catch (error) {
    console.error(`[VectorStore] Failed to delete OpenAI file:`, error.message);
  }

  return {
    deleted: vectorStoreDeletionSuccess || openaiFileDeletionSuccess,
    vector_store_deleted: vectorStoreDeletionSuccess,
    openai_file_deleted: openaiFileDeletionSuccess
  };
};

/**
 * Search user's vector store for relevant lessons
 * @param {string} userId - Supabase user ID
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results (default 3)
 * @returns {Promise<Array>} Search results with content and metadata
 */
const searchVectorStore = async (userId, query, maxResults = 3) => {
  const vectorStoreId = await getUserVectorStore(userId);

  if (!vectorStoreId) {
    console.log(`[VectorStore] User ${userId} has no vector store, returning empty results`);
    return [];
  }

  try {
    // Use OpenAI vector store search API
    // Note: If SDK doesn't have vectorStores.search(), this will fail with a clear error
    let results;

    if (typeof openaiClient.vectorStores.search === 'function') {
      // SDK method exists
      results = await openaiClient.vectorStores.search(vectorStoreId, {
        query,
        max_num_results: maxResults
      });
    } else {
      // Fallback: use fetch directly
      const response = await fetch(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, max_num_results: maxResults })
      });

      if (!response.ok) {
        throw new Error(`Search API error: ${response.status} ${response.statusText}`);
      }

      results = await response.json();
    }

    console.log(`[VectorStore] Search returned ${results?.data?.length || 0} results for query: "${query}"`);
    return results?.data || [];

  } catch (error) {
    console.error(`[VectorStore] Search failed:`, error.message);
    // Return empty results on error (non-critical)
    return [];
  }
};

module.exports = {
  ensureVectorStore,
  getUserVectorStore,
  uploadLessonToVectorStore,
  deleteLessonFromVectorStore,
  searchVectorStore,
  // Export helper functions for potential testing/debugging
  getUserSettings,
  updateUserSettings
};
