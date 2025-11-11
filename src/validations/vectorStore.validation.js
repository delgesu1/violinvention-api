const Joi = require('joi');

const uploadLesson = {
  body: Joi.object().keys({
    summary: Joi.string().required(),
    transcript: Joi.string().required(),
    metadata: Joi.object().keys({
      lesson_id: Joi.string().required(),
      title: Joi.string().optional().allow(''),
      date: Joi.string().optional().allow(''),
      student_name: Joi.string().optional().allow(''),
      tags: Joi.array().items(Joi.object()).optional(),
      all_tags: Joi.alternatives().try(
        Joi.array().items(Joi.object()),
        Joi.string()
      ).optional()
    }).required()
  })
};

const deleteLesson = {
  body: Joi.object().keys({
    vector_store_file_id: Joi.string().required(),
    openai_file_id: Joi.string().required()
  })
};

const searchVectorStore = {
  body: Joi.object().keys({
    query: Joi.string().required(),
    max_results: Joi.number().integer().min(1).max(50).optional()
  })
};

module.exports = {
  uploadLesson,
  deleteLesson,
  searchVectorStore
};
