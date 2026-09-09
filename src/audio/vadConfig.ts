export const VAD_CONFIG = {
  positiveSpeechThreshold: 0.35, // speech confidemce thresholds for starting and ending speech
  negativeSpeechThreshold: 0.20,
  redemptionFrames: 9,          // consecutive non-speech frames before ending a segment (~288ms at 32ms/frame)
  minSegmentDuration: 15,       // seconds - flush on speech→silence if above this
  maxSegmentDuration: 29.9,     // seconds - forced cut
  hardCutLookback: 15,          // seconds to look back for best cut point
  minSpeechFrames: 6,           // cumulative frames >= positiveSpeechThreshold required to send a segment
                                 // (~192ms at 32ms/frame); below this it's a VAD misfire (cough, click) and is discarded
  leadingPadFrames: 31,          // ~1s of silence kept before detected speech onset when trimming a
                                 // segment's lead-in (generous on purpose: clipping onset costs accuracy,
                                 // unlike trailing silence). vad-web's own default (preSpeechPadMs: 800,
                                 // i.e. 25 frames) is smaller; we pad further still for extra safety margin
  maxConcurrentRequests: 3,
  retryAttempts: 2,
  retryBaseDelayMs: 1000,
  sampleRate: 16000,
  frameSizeSamples: 512,      // v5 model: 32ms per frame
} as const;
