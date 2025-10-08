const { createChat, updateChat, getAllChats, deleteChat } = require("../services/chat.service");
const catchAsync = require("../utils/catchAsync");

const create = catchAsync(async (req, res) => {
  const chat = await createChat(req.user, req.body.title, req.body.chat_mode || 'arcoai');
  res.json({ chat });
});

const patch = catchAsync(async (req, res) => {
  const chat = await updateChat(req.user, req.params.chatId, {
    title: req.body.title,
    chat_mode: req.body.chat_mode,
  });
  res.json({ chat });
});

const findAll = catchAsync(async (req, res) => {
  const chats = await getAllChats(req.user);
  res.json({ chats });
});

const deleteChatController = catchAsync(async (req, res) => {
  await deleteChat(req.user, req.params.chatId);
  res.json({ message: "Chat deleted successfully!" });
});

module.exports = { create, patch, findAll, delete: deleteChatController };
