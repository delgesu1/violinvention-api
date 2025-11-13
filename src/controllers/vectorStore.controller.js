const catchAsync = require('../utils/catchAsync');
const { vectorStoreService } = require('../services');
const httpStatus = require('http-status');
const logger = require('../config/logger');

/**
 * Upload lesson (summary + transcript) to user's vector store
 * POST /v1/vector_store/upload
 */
const uploadLesson = catchAsync(async (req, res) => {
  const startTime = Date.now();
  const { summary, transcript, metadata } = req.body;
  const userId = req.user.id;
  const recordingId = metadata?.lesson_id;

  logger.info('[VectorStore] Upload started', {
    userId,
    recordingId,
    hasTranscript: !!transcript,
    hasSummary: !!summary,
    transcriptLength: transcript?.length || 0,
    summaryLength: summary?.length || 0,
  });

  try {
    const result = await vectorStoreService.uploadLessonToVectorStore(
      userId,
      summary,
      transcript,
      metadata
    );

    const durationMs = Date.now() - startTime;
    logger.info('[VectorStore] Upload succeeded', {
      userId,
      recordingId,
      vectorStoreFileId: result.vector_store_file_id,
      openaiFileId: result.openai_file_id,
      durationMs,
    });

    res.status(httpStatus.CREATED).json({
      success: true,
      ...result
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error('[VectorStore] Upload failed', {
      userId,
      recordingId,
      statusCode: error.statusCode,
      message: error.message,
      durationMs,
    });
    throw error; // Re-throw for catchAsync to handle
  }
});

/**
 * Delete lesson from user's vector store
 * DELETE /v1/vector_store/delete
 */
const deleteLesson = catchAsync(async (req, res) => {
  const { vector_store_file_id, openai_file_id } = req.body;
  const userId = req.user.id;

  logger.info('[VectorStore] Delete started', {
    userId,
    vectorStoreFileId: vector_store_file_id,
    openaiFileId: openai_file_id,
  });

  try {
    const result = await vectorStoreService.deleteLessonFromVectorStore(
      userId,
      vector_store_file_id,
      openai_file_id
    );

    logger.info('[VectorStore] Delete succeeded', {
      userId,
      vectorStoreFileId: vector_store_file_id,
      deleted: result.deleted,
    });

    res.status(httpStatus.OK).json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('[VectorStore] Delete failed', {
      userId,
      vectorStoreFileId: vector_store_file_id,
      message: error.message,
    });
    throw error;
  }
});

/**
 * Search user's vector store (for debugging/testing)
 * POST /v1/vector_store/search
 */
const searchVectorStore = catchAsync(async (req, res) => {
  const { query, max_results = 3 } = req.body;
  const userId = req.user.id;

  const results = await vectorStoreService.searchVectorStore(
    userId,
    query,
    max_results
  );

  res.status(httpStatus.OK).json({
    success: true,
    results,
    count: results.length
  });
});

module.exports = {
  uploadLesson,
  deleteLesson,
  searchVectorStore
};
