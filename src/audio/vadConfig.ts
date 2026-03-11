export const VAD_CONFIG = {
  positiveSpeechThreshold: 0.35,
  negativeSpeechThreshold: 0.20,
  redemptionFrames: 9,          // consecutive non-speech frames before ending a segment (~288ms at 32ms/frame)
  minSegmentDuration: 15,       // seconds - flush on speech→silence if above this
  maxSegmentDuration: 29.9,     // seconds - forced cut
  hardCutLookback: 15,          // seconds to look back for best cut point
  minFinalSegmentDuration: 0.5, // seconds - discard trailing silence below this
  maxConcurrentRequests: 3,
  retryAttempts: 2,
  retryBaseDelayMs: 1000,
  sampleRate: 16000,
  frameSizeSamples: 512,      // v5 model: 32ms per frame
} as const;
