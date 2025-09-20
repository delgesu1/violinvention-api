const express = require("express");
// Use Supabase authentication directly
const { supabaseAuth } = require("../../middlewares/supabaseAuth");
const validate = require("../../middlewares/validate");
const messageValidation = require("../../validations/message.validation");
const messageController = require("../../controllers/message.controller");

const router = express.Router();

router
  .route("/")
  .post(supabaseAuth("sendMessage"), validate(messageValidation.sendMessage), messageController.sendMessage);

router
  .route("/first")
  .post(supabaseAuth("sendMessage"), validate(messageValidation.sendFirstMessage), messageController.sendFirstMessage);

router
  .route("/:chatId")
  .get(supabaseAuth("getMessages"), validate(messageValidation.findAllMessages), messageController.findAllMessages);

module.exports = router;

/**
 * @swagger
 * tags:
 *   name: Messages
 *   description: Message management and retrieval
 */

/**
 * @swagger
 * /messages:
 *   post:
 *     summary: Send a message
 *     description: Users can send messages within a chat.
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chat_id:
 *                 type: string
 *               message:
 *                 type: string
 *               instructionToken:
 *                 type: string
 *                 nullable: true
 *             example:
 *               chat_id: "abc123"
 *               message: "Hello, how are you?"
 *               instructionToken: "some-instruction"
 *     responses:
 *       "201":
 *         description: Message sent
 *       "400":
 *         description: Invalid request data
 *
 * /messages/{chatId}:
 *   get:
 *     summary: Get all messages
 *     description: Retrieve all messages within a chat.
 *     tags: [Messages]
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
 */
