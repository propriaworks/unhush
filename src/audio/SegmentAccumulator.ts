import { VAD_CONFIG } from "./vadConfig";

export class SegmentAccumulator {
  private frames: Float32Array[] = [];
  private scores: number[] = [];
  private sampleCount = 0;
  private wasSpeaking = false;
  private redemptionCounter = 0;
  private segmentIndex = 0;
  private onFlush: (wavBlob: Blob, segmentIndex: number, durationSec: number) => void;
  onLog: ((level: "info" | "warn" | "error", message: string) => void) | null = null;

  // Debug: retains references to all frames across flushes for full-recording export
  private allFrames: Float32Array[] | null = null;

  constructor(onFlush: (wavBlob: Blob, segmentIndex: number, durationSec: number) => void) {
    this.onFlush = onFlush;
  }

  /** Enable debug mode — retains all frames for getFullRecordingWav() */
  enableDebug(): void {
    this.allFrames = [];
  }

  addFrame(isSpeech: number, frame: Float32Array): void {
    const copy = new Float32Array(frame); // copy since vad-web may reuse buffer
    this.frames.push(copy);
    if (this.allFrames) this.allFrames.push(copy); // same reference, no extra copy
    this.scores.push(isSpeech);
    this.sampleCount += frame.length;

    const durationSec = this.sampleCount / VAD_CONFIG.sampleRate;

    // Hard cut: approaching Whisper's 30s limit
    if (durationSec >= VAD_CONFIG.maxSegmentDuration) {
      this.hardCut();
      return;
    }

    // Speech state with hysteresis: start speaking at positiveSpeechThreshold,
    // stop speaking only after redemptionFrames consecutive frames below negativeSpeechThreshold
    if (isSpeech >= VAD_CONFIG.positiveSpeechThreshold) {
      this.wasSpeaking = true;
      this.redemptionCounter = 0;
    } else if (this.wasSpeaking && isSpeech < VAD_CONFIG.negativeSpeechThreshold) {
      this.redemptionCounter++;
      if (this.redemptionCounter >= VAD_CONFIG.redemptionFrames) {
        // Speech has ended — flush if we have enough audio
        this.wasSpeaking = false;
        this.redemptionCounter = 0;

        // Natural pause: speech->silence transition with enough accumulated audio. send prior segment for transcription.
        if (durationSec >= VAD_CONFIG.minSegmentDuration) {
          this.flush(this.frames.length);
        }
      }
    } else if (this.wasSpeaking) {
      // Frame is between negativeSpeechThreshold and positiveSpeechThreshold — reset redemption
      this.redemptionCounter = 0;
    }
  }

  /** Forced cut near max duration - finds the best cut point by looking back for minimum speech score */
  private hardCut(): void {
    const lookbackFrames = Math.floor(
      (VAD_CONFIG.hardCutLookback * VAD_CONFIG.sampleRate) / VAD_CONFIG.frameSizeSamples
    );
    const searchStart = Math.max(0, this.scores.length - lookbackFrames);

    // Find frame with minimum speech score in the lookback window
    let minScore = Infinity;
    let minIdx = searchStart;
    for (let i = searchStart; i < this.scores.length; i++) {
      if (this.scores[i] < minScore) {
        minScore = this.scores[i];
        minIdx = i;
      }
    }

    // Cut at minIdx+1: frames [0..minIdx] go to the current segment
    const cutPoint = minIdx + 1;
    const remainingFrames = this.frames.slice(cutPoint);
    const remainingScores = this.scores.slice(cutPoint);

    this.flush(cutPoint);

    // Start new segment with the remaining frames
    this.frames = remainingFrames;
    this.scores = remainingScores;
    this.sampleCount = remainingFrames.reduce((sum, f) => sum + f.length, 0);
    // Carry forward speech state from the last remaining frame
    this.wasSpeaking = remainingScores.length > 0
      ? remainingScores[remainingScores.length - 1] >= VAD_CONFIG.positiveSpeechThreshold
      : false;
    this.redemptionCounter = 0;
  }

  /**
   * Flush frames [0..count) as a WAV blob, subject to two VAD-based safeguards:
   *  - Gate: segments with fewer than minSpeechFrames of actual speech are VAD misfires
   *    (coughs, clicks) rather than transcribable content — discard rather than send.
   *  - Trim: trailing silence beyond redemptionFrames past the last speech-adjacent frame is
   *    cut from what's sent (but not from the frames considered "consumed" by this flush) —
   *    this only matters for flushRemaining, since natural-pause flushes already end at
   *    redemptionFrames past speech and hardCut picks its own low-score cut point.
   * The trim anchors on negativeSpeechThreshold rather than positiveSpeechThreshold so that
   * soft word endings (trailing fricatives etc., where Silero's score sags) aren't clipped.
   */
  private flush(frameCount: number): void {
    const framesInRange = this.frames.slice(0, frameCount);
    if (framesInRange.length === 0) return;

    const scoresInRange = this.scores.slice(0, frameCount);
    const totalDurationSec = framesInRange.reduce((sum, f) => sum + f.length, 0) / VAD_CONFIG.sampleRate;

    const speechFrameCount = scoresInRange.filter((s) => s >= VAD_CONFIG.positiveSpeechThreshold).length;

    if (speechFrameCount < VAD_CONFIG.minSpeechFrames) {
      this.onLog?.(
        "info",
        `flush: discarding ${totalDurationSec.toFixed(2)}s segment as VAD misfire ` +
          `(${speechFrameCount} speech frame(s), need ${VAD_CONFIG.minSpeechFrames})`
      );
    } else {
      let lastSpeechIdx = scoresInRange.length - 1;
      for (let i = scoresInRange.length - 1; i >= 0; i--) {
        if (scoresInRange[i] >= VAD_CONFIG.negativeSpeechThreshold) {
          lastSpeechIdx = i;
          break;
        }
      }
      const trimEnd = Math.min(scoresInRange.length, lastSpeechIdx + 1 + VAD_CONFIG.redemptionFrames);

      const framesToSend = framesInRange.slice(0, trimEnd);
      const durationSec = framesToSend.reduce((sum, f) => sum + f.length, 0) / VAD_CONFIG.sampleRate;
      if (trimEnd < framesInRange.length) {
        this.onLog?.("info", `flush: trimmed ${(totalDurationSec - durationSec).toFixed(2)}s of trailing silence`);
      }

      const wavBlob = SegmentAccumulator.encodeWav(framesToSend, VAD_CONFIG.sampleRate);
      const idx = this.segmentIndex++;
      this.onFlush(wavBlob, idx, durationSec);
    }

    // If we flushed everything (natural pause / flushRemaining), reset current segment
    if (frameCount >= this.frames.length) {
      this.reset(false)
    }
  }

  /** Flush whatever remains at end of recording (subject to flush()'s misfire gate) */
  flushRemaining(): void {
    if (this.frames.length === 0) return;
    this.flush(this.frames.length);
  }

  /** Total number of segments produced so far */
  get totalSegments(): number {
    return this.segmentIndex;
  }

  /** Encode the complete recording (all frames from all segments) as a single WAV. Debug only. */
  getFullRecordingWav(): Blob | null {
    if (!this.allFrames || this.allFrames.length === 0) return null;
    return SegmentAccumulator.encodeWav(this.allFrames, VAD_CONFIG.sampleRate);
  }

  /* reset the accumulator. if all is false, preserve segmentIndex & allFrames so we don't lose prior segments */
  reset(all: boolean = true): void {
    this.frames = [];
    this.scores = [];
    this.sampleCount = 0;
    this.wasSpeaking = false;
    this.redemptionCounter = 0;
    if (all) {
      this.segmentIndex = 0;
      this.allFrames = null;
    }
  }

  /** Encode Float32Array PCM frames into a 16-bit WAV blob */
  static encodeWav(frames: Float32Array[], sampleRate: number): Blob {
    // Calculate total sample count
    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const dataLength = totalSamples * 2; // 16-bit = 2 bytes per sample
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);   // sample rate
    view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeString(36, "data");
    view.setUint32(40, dataLength, true);

    // Write PCM samples: convert Float32 [-1, 1] to Int16
    let offset = 44;
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        const sample = Math.max(-1, Math.min(1, frame[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: "audio/wav" });
  }
}
