const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const recordingProcessingService = require('../services/recordingProcessing.service');

const processRecording = catchAsync(async (req, res) => {
  const { transcript, instrument, genre } = req.body;

  const result = await recordingProcessingService.processRecording({
    transcript,
    instrumentPreference: instrument,
    genrePreference: genre,
  });

  res.status(httpStatus.OK).send({
    summary: result.summary,
    student_tag: result.studentTag || null,
    title: result.title || null,
    raw_tag_response: result.rawTagResponse || null,
  });
});

module.exports = {
  processRecording,
};
