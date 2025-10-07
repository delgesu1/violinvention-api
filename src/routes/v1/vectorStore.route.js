const express = require('express');
const { supabaseAuth } = require('../../middlewares/supabaseAuth');
const validate = require('../../middlewares/validate');
const vectorStoreValidation = require('../../validations/vectorStore.validation');
const vectorStoreController = require('../../controllers/vectorStore.controller');

const router = express.Router();

router
  .route('/upload')
  .post(
    supabaseAuth('uploadLesson'),
    validate(vectorStoreValidation.uploadLesson),
    vectorStoreController.uploadLesson
  );

router
  .route('/delete')
  .delete(
    supabaseAuth('deleteLesson'),
    validate(vectorStoreValidation.deleteLesson),
    vectorStoreController.deleteLesson
  );

router
  .route('/search')
  .post(
    supabaseAuth('searchVectorStore'),
    validate(vectorStoreValidation.searchVectorStore),
    vectorStoreController.searchVectorStore
  );

module.exports = router;

/**
 * @swagger
 * tags:
 *   name: VectorStore
 *   description: Vector store management for lesson context
 */

/**
 * @swagger
 * /vector_store/upload:
 *   post:
 *     summary: Upload lesson to user's vector store
 *     description: Uploads a lesson (summary + transcript) to the user's personal vector store for semantic search
 *     tags: [VectorStore]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - summary
 *               - transcript
 *               - metadata
 *             properties:
 *               summary:
 *                 type: string
 *                 description: Lesson summary text
 *               transcript:
 *                 type: string
 *                 description: Lesson transcript text
 *               metadata:
 *                 type: object
 *                 required:
 *                   - lesson_id
 *                 properties:
 *                   lesson_id:
 *                     type: string
 *                   title:
 *                     type: string
 *                   date:
 *                     type: string
 *                   student_name:
 *                     type: string
 *                   tags:
 *                     type: array
 *                     items:
 *                       type: object
 *             example:
 *               summary: "Lesson focused on vibrato technique..."
 *               transcript: "Full lesson transcript here..."
 *               metadata:
 *                 lesson_id: "rec_abc123"
 *                 title: "Vibrato Practice Session"
 *                 date: "2025-10-07"
 *                 student_name: "John Doe"
 *                 tags: []
 *     responses:
 *       "201":
 *         description: Lesson uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 openai_file_id:
 *                   type: string
 *                 vector_store_file_id:
 *                   type: string
 *       "400":
 *         description: Invalid request data
 *       "401":
 *         description: Unauthorized
 *
 * /vector_store/delete:
 *   delete:
 *     summary: Delete lesson from vector store
 *     description: Removes a lesson from the user's vector store (both vector store file and OpenAI file)
 *     tags: [VectorStore]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vector_store_file_id
 *               - openai_file_id
 *             properties:
 *               vector_store_file_id:
 *                 type: string
 *                 description: Vector store file ID
 *               openai_file_id:
 *                 type: string
 *                 description: OpenAI file ID
 *             example:
 *               vector_store_file_id: "file-abc123"
 *               openai_file_id: "file-xyz789"
 *     responses:
 *       "200":
 *         description: Lesson deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deleted:
 *                   type: boolean
 *                 vector_store_deleted:
 *                   type: boolean
 *                 openai_file_deleted:
 *                   type: boolean
 *       "400":
 *         description: Invalid request data
 *       "401":
 *         description: Unauthorized
 *
 * /vector_store/search:
 *   post:
 *     summary: Search user's vector store
 *     description: Search the user's vector store for relevant lessons (for debugging/testing)
 *     tags: [VectorStore]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: Search query
 *               max_results:
 *                 type: number
 *                 description: Maximum number of results (1-50)
 *                 default: 3
 *             example:
 *               query: "vibrato technique"
 *               max_results: 3
 *     responses:
 *       "200":
 *         description: Search completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 count:
 *                   type: number
 *       "400":
 *         description: Invalid request data
 *       "401":
 *         description: Unauthorized
 */
