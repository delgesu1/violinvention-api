const Joi = require("joi");
const { objectId } = require("./custom.validation");

const createChat = {
  body: Joi.object().keys({
    title: Joi.string().optional(),
    chat_mode: Joi.string().valid('arcoai', 'personal_lessons').optional(),
  }),
};

const updateChat = {
  params: Joi.object().keys({
    chatId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    title: Joi.string().optional(),
    chat_mode: Joi.string().valid('arcoai', 'personal_lessons').optional(),
  }).min(1),
};

const deleteChat = {
  params: Joi.object().keys({
    chatId: Joi.string().custom(objectId).required(),
  }),
};

const getChats = {
  query: Joi.object().keys({}),
};

module.exports = { createChat, updateChat, deleteChat, getChats };
