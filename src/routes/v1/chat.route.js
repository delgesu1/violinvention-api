const express = require("express");
// Use Supabase authentication directly
const { supabaseAuth } = require("../../middlewares/supabaseAuth");
const validate = require("../../middlewares/validate");
const chatValidation = require("../../validations/chat.validation");
const chatController = require("../../controllers/chat.controller");

const router = express.Router();

router
  .route("/")
  .post(supabaseAuth("manageChats"), validate(chatValidation.createChat), chatController.create)
  .get(supabaseAuth("manageChats"), validate(chatValidation.getChats), chatController.findAll);

router
  .route("/:chatId")
  .delete(supabaseAuth("manageChats"), validate(chatValidation.deleteChat), chatController.delete)
  .patch(supabaseAuth("manageChats"), validate(chatValidation.updateChat), chatController.patch);

module.exports = router;

/**
 * @swagger
 * tags:
 *   name: Chats
 *   description: Chat management and retrieval
 */

/**
 * @swagger
 * /chats:
 *   post:
 *     summary: Create a chat
 *     description: Users can create chats.
 *     tags: [Chats]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *             example:
 *               title: "New Chat"
 *     responses:
 *       "201":
 *         description: Created
 *       "400":
 *         description: Invalid request data
 *
 *   get:
 *     summary: Get all chats
 *     description: Retrieve all chats for a user.
 *     tags: [Chats]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       "200":
 *         description: OK
 *
 * /chats/{chatId}:
 *   get:
 *     summary: Get a chat
 *     description: Retrieve a single chat by ID.
 *     tags: [Chats]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       "200":
 *         description: OK
 *       "404":
 *         description: Chat not found
 *
 *   delete:
 *     summary: Delete a chat
 *     description: Users can delete their own chats.
 *     tags: [Chats]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       "204":
 *         description: No content
 *   patch:
 *     summary: Update a chat
 *     description: Users can update their own chats.
 *     tags: [Chats]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *             example:
 *               title: "New Chat"
 *     responses:
 *       "204":
 *         description: No content
 */
