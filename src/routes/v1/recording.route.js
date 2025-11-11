const express = require('express');
const { supabaseAuth } = require('../../middlewares/supabaseAuth');
const validate = require('../../middlewares/validate');
const recordingValidation = require('../../validations/recording.validation');
const recordingController = require('../../controllers/recording.controller');

const router = express.Router();

router
  .route('/process')
  .post(
    supabaseAuth('processRecording'),
    validate(recordingValidation.processRecording),
    recordingController.processRecording
  );

module.exports = router;
