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
    chat_mode: Joi.string().valid('arcoai', 'personal_lessons').optional(),
    lesson_plan_prompt: Joi.boolean().optional(),
    model: Joi.string().valid('arco', 'arco-pro').optional(),
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
    chat_mode: Joi.string().valid('arcoai', 'personal_lessons').optional(),
    lesson_plan_prompt: Joi.boolean().optional(),
    model: Joi.string().valid('arco', 'arco-pro').optional(),
  }),
};

module.exports = { sendMessage, findAllMessages, sendFirstMessage };
