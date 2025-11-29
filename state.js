// state.js — small shared runtime state used by meet modules
module.exports = {
  previewProcess: null,
  ffmpegProcess: null,
  isRecording: false,
  currentRecordingPath: null,
  audioWsServer: null,
  audioHttpServer: null,
  audioWsPort: null,
};
