const Joi = require("joi");
const { objectId } = require("./custom.validation");

const createChat = {
  body: Joi.object().keys({
    title: Joi.string().optional(),
  }),
};

const updateChat = {
  params: Joi.object().keys({
    chatId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    title: Joi.string().optional(),
  }),
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