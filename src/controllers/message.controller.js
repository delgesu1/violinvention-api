const catchAsync = require("../utils/catchAsync");
const { messageService } = require("../services");

const sendMessage = catchAsync(async (req, res, next) => {
  await messageService.sendMessage({
    message: req.body.message,
    chat_id: req.body.chat_id,
    instruction_token: req.body.instruction_token,
    lesson_context: req.body.lesson_context,
    user: req.user,
    req,
    res,
  });
});

const findAllMessages = catchAsync(async (req, res, next) => {
  const messages = await messageService.findAllMessages(req.params.chatId, req.user);
  res.json({ messages });
});

const sendFirstMessage = catchAsync(async (req, res, next) => {
  await messageService.sendFirstMessage({
    message: req.body.message,
    instruction_token: req.body.instruction_token,
    lesson_context: req.body.lesson_context,
    chat_mode: req.body.chat_mode,
    user: req.user,
    req,
    res,
  });
});

module.exports = { sendMessage, findAllMessages, sendFirstMessage };
