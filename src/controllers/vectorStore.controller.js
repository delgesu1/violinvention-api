const catchAsync = require('../utils/catchAsync');
const { vectorStoreService } = require('../services');
const httpStatus = require('http-status');

/**
 * Upload lesson (summary + transcript) to user's vector store
 * POST /v1/vector_store/upload
 */
const uploadLesson = catchAsync(async (req, res) => {
  const { summary, transcript, metadata } = req.body;
  const userId = req.user.id;

  const result = await vectorStoreService.uploadLessonToVectorStore(
    userId,
    summary,
    transcript,
    metadata
  );

  res.status(httpStatus.CREATED).json({
    success: true,
    ...result
  });
});

/**
 * Delete lesson from user's vector store
 * DELETE /v1/vector_store/delete
 */
const deleteLesson = catchAsync(async (req, res) => {
  const { vector_store_file_id, openai_file_id } = req.body;
  const userId = req.user.id;

  const result = await vectorStoreService.deleteLessonFromVectorStore(
    userId,
    vector_store_file_id,
    openai_file_id
  );

  res.status(httpStatus.OK).json({
    success: true,
    ...result
  });
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
