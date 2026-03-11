export const VAD_CONFIG = {
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  minChunkDuration: 20,       // seconds - flush on speech→silence if above this
  maxChunkDuration: 29.9,     // seconds - forced cut
  hardCutLookback: 15,        // seconds to look back for best cut point
  minFinalChunkDuration: 0.5, // seconds - discard trailing silence below this
  maxConcurrentRequests: 3,
  retryAttempts: 2,
  retryBaseDelayMs: 1000,
  sampleRate: 16000,
  frameSizeSamples: 512,      // v5 model: 32ms per frame
} as const;
