const Joi = require("joi");
const { objectId } = require("./custom.validation");

const sendMessage = {
  body: Joi.object().keys({
    message: Joi.string().required(),
    chat_id: Joi.string().custom(objectId).required(),
    instruction_token: Joi.string().optional().allow(""),
    lesson_context: Joi.array().items(
      Joi.object({
        title: Joi.string().required(),
        date: Joi.string().required()
      })
    ).optional(),
  }),
};

const findAllMessages = {
  params: Joi.object().keys({
    chatId: Joi.string().custom(objectId).required(),
  }),
};

const sendFirstMessage = {
  body: Joi.object().keys({
    message: Joi.string().required(),
    instruction_token: Joi.string().optional().allow(""),
    lesson_context: Joi.array().items(
      Joi.object({
        title: Joi.string().required(),
        date: Joi.string().required()
      })
    ).optional(),
  }),
};

module.exports = { sendMessage, findAllMessages, sendFirstMessage };
