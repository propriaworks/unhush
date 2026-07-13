import { describe, it, expect, vi } from "vitest";
import { SegmentAccumulator } from "./SegmentAccumulator";
import { VAD_CONFIG } from "./vadConfig";

// Covers the VAD-based safeguards in flush(): the minSpeechFrames misfire gate (discard
// segments with too little actual speech — coughs, clicks) and the trailing-silence trim
// (anchored on negativeSpeechThreshold + redemptionFrames padding, so soft word endings
// aren't clipped). Exercised through the public addFrame()/flushRemaining() surface rather
// than private state, since that's what production code paths actually drive.

const FRAME_SEC = VAD_CONFIG.frameSizeSamples / VAD_CONFIG.sampleRate;
const SPEECH = 0.9; // well above positiveSpeechThreshold
const SILENCE = 0.05; // well below negativeSpeechThreshold

function makeFrame(): Float32Array {
  return new Float32Array(VAD_CONFIG.frameSizeSamples);
}

function makeAccumulator() {
  const onFlush = vi.fn<(wavBlob: Blob, segmentIndex: number, durationSec: number) => void>();
  const onLog = vi.fn<(level: "info" | "warn" | "error", message: string) => void>();
  const acc = new SegmentAccumulator(onFlush);
  acc.onLog = onLog;
  return { acc, onFlush, onLog };
}

function feed(acc: SegmentAccumulator, score: number, count: number) {
  for (let i = 0; i < count; i++) acc.addFrame(score, makeFrame());
}

describe("SegmentAccumulator VAD safeguards", () => {
  it("trims trailing silence on flushRemaining, keeping redemptionFrames of padding", () => {
    const { acc, onFlush, onLog } = makeAccumulator();

    feed(acc, SPEECH, 20);
    feed(acc, SILENCE, 50); // long dead air before the user hits stop

    acc.flushRemaining();

    expect(onFlush).toHaveBeenCalledTimes(1);
    const [wavBlob, segmentIndex, durationSec] = onFlush.mock.calls[0];
    expect(wavBlob).toBeInstanceOf(Blob);
    expect(segmentIndex).toBe(0);
    expect(durationSec).toBeCloseTo((20 + VAD_CONFIG.redemptionFrames) * FRAME_SEC, 5);
    expect(onLog).toHaveBeenCalledWith("info", expect.stringContaining("trimmed"));
  });

  it("discards an all-silence tail instead of sending it", () => {
    const { acc, onFlush, onLog } = makeAccumulator();

    feed(acc, SILENCE, 10);
    acc.flushRemaining();

    expect(onFlush).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith("info", expect.stringContaining("VAD misfire"));
    expect(acc.totalSegments).toBe(0);
  });

  it("discards a single blip (cough/click) surrounded by silence", () => {
    const { acc, onFlush } = makeAccumulator();

    feed(acc, SILENCE, 5);
    feed(acc, SPEECH, 3); // below minSpeechFrames (6)
    feed(acc, SILENCE, 20);
    acc.flushRemaining();

    expect(onFlush).not.toHaveBeenCalled();
    expect(acc.totalSegments).toBe(0);
  });

  it("flushes normally when speech reaches minSpeechFrames", () => {
    const { acc, onFlush } = makeAccumulator();

    feed(acc, SILENCE, 5);
    feed(acc, SPEECH, VAD_CONFIG.minSpeechFrames);
    feed(acc, SILENCE, 20);
    acc.flushRemaining();

    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("natural-pause flush needs no trim (already ends at redemptionFrames past speech)", () => {
    const { acc, onFlush, onLog } = makeAccumulator();

    // enough speech that duration >= minSegmentDuration once redemption completes
    const speechFrames = Math.ceil(VAD_CONFIG.minSegmentDuration / FRAME_SEC) - VAD_CONFIG.redemptionFrames + 1;
    feed(acc, SPEECH, speechFrames);
    feed(acc, SILENCE, VAD_CONFIG.redemptionFrames); // completes redemption -> auto flush

    expect(onFlush).toHaveBeenCalledTimes(1);
    const [, , durationSec] = onFlush.mock.calls[0];
    expect(durationSec).toBeCloseTo((speechFrames + VAD_CONFIG.redemptionFrames) * FRAME_SEC, 5);
    expect(onLog).not.toHaveBeenCalledWith("info", expect.stringContaining("trimmed"));
  });

  it("hardCut on pure silence discards the segment and keeps accumulating (no blank interior segment)", () => {
    const { acc, onFlush } = makeAccumulator();

    const framesToHardCut = Math.ceil(VAD_CONFIG.maxSegmentDuration / FRAME_SEC);
    feed(acc, SILENCE, framesToHardCut);

    // hardCut fired internally at maxSegmentDuration but the cut segment was silence-only
    expect(onFlush).not.toHaveBeenCalled();
    expect(acc.totalSegments).toBe(0);

    // clear the (also silent) leftover from the hard cut so it can't bleed duration into
    // the next utterance and trip the minSegmentDuration natural-pause check early
    acc.flushRemaining();
    expect(onFlush).not.toHaveBeenCalled();

    // recording continues normally afterwards
    feed(acc, SPEECH, VAD_CONFIG.minSpeechFrames + 5);
    feed(acc, SILENCE, 20);
    acc.flushRemaining();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(acc.totalSegments).toBe(1);
    const [, segmentIndex] = onFlush.mock.calls[0];
    expect(segmentIndex).toBe(0); // gated hardCut/flushRemaining discards did not consume a segmentIndex
  });

  it("hardCut on continuous speech still flushes, and later segments increment segmentIndex in order", () => {
    const { acc, onFlush } = makeAccumulator();

    const framesToHardCut = Math.ceil(VAD_CONFIG.maxSegmentDuration / FRAME_SEC);
    feed(acc, SPEECH, framesToHardCut); // continuous speech forces a hardCut, not a natural pause

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][1]).toBe(0);

    // more speech (on top of the hardCut's leftover speech tail), then a natural pause
    feed(acc, SPEECH, VAD_CONFIG.minSpeechFrames + 5);
    feed(acc, SILENCE, VAD_CONFIG.redemptionFrames);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1][1]).toBe(1);
    expect(acc.totalSegments).toBe(2);
  });
});
