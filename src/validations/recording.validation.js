const Joi = require('joi');

const processRecording = {
  body: Joi.object().keys({
    transcript: Joi.string().min(10).required(),
    instrument: Joi.string().allow(null, '').optional(),
    genre: Joi.string().allow(null, '').optional(),
  }),
};

module.exports = {
  processRecording,
};
