import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperQueue } from "./WhisperQueue";
import { transcribeAudioBlob } from "./transcriptionApi";
import { VAD_CONFIG } from "./vadConfig";

vi.mock("./transcriptionApi", () => ({ transcribeAudioBlob: vi.fn() }));
const transcribe = vi.mocked(transcribeAudioBlob);

// Each transcription request stays pending until the test settles it, so completion order
// (and how many are in flight at once) is under the test's control.
type Pending = { blob: Blob; resolve: (text: string) => void; reject: (err: Error) => void };
let pending: Pending[];

const config = { apiUrl: "http://localhost:8000/v1/audio/transcriptions", apiKey: "", model: "m" };
const segments = Array.from({ length: 6 }, (_, i) => new Blob([`segment ${i}`]));
const requestFor = (i: number) => pending.find((p) => p.blob === segments[i])!;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  transcribe.mockReset();
  transcribe.mockImplementation(
    (blob) => new Promise((resolve, reject) => pending.push({ blob, resolve, reject })),
  );
  vi.spyOn(console, "error").mockImplementation(() => {}); // permanent failures log here
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WhisperQueue", () => {
  it("joins results in segment order, whatever order they finish in, skipping empty ones", async () => {
    const queue = new WhisperQueue(config);
    for (const i of [0, 1, 2]) queue.enqueue(segments[i], i);
    const transcript = queue.finalize(3, " | ");

    requestFor(2).resolve("third");
    requestFor(0).resolve("first");
    requestFor(1).resolve(""); // e.g. a segment Whisper heard nothing in
    await expect(transcript).resolves.toBe("first | third");
  });

  it("resolves finalize() at once if every segment is already transcribed", async () => {
    const queue = new WhisperQueue(config);
    queue.enqueue(segments[0], 0);
    requestFor(0).resolve("only");
    await flush();
    await expect(queue.finalize(1)).resolves.toBe("only");
  });

  it(`keeps at most maxConcurrentRequests (${VAD_CONFIG.maxConcurrentRequests}) requests in flight`, async () => {
    const queue = new WhisperQueue(config);
    for (let i = 0; i < 5; i++) queue.enqueue(segments[i], i);
    expect(transcribe).toHaveBeenCalledTimes(VAD_CONFIG.maxConcurrentRequests);

    requestFor(0).resolve("a");
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(VAD_CONFIG.maxConcurrentRequests + 1);
  });

  it("retries a failed segment with exponential backoff, and recovers if a retry succeeds", async () => {
    const queue = new WhisperQueue(config);
    queue.enqueue(segments[0], 0);
    const transcript = queue.finalize(1);

    for (let attempt = 0; attempt < VAD_CONFIG.retryAttempts; attempt++) {
      pending.pop()!.reject(new Error("503"));
      await flush();
      const delay = VAD_CONFIG.retryBaseDelayMs * 2 ** attempt;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(transcribe).toHaveBeenCalledTimes(attempt + 1); // not retried early
      await vi.advanceTimersByTimeAsync(1);
      expect(transcribe).toHaveBeenCalledTimes(attempt + 2);
    }

    pending.pop()!.resolve("finally");
    await expect(transcript).resolves.toBe("finally");
  });

  it("fails the whole transcript once a segment exhausts its retries, reporting it only once", async () => {
    const onFatalError = vi.fn();
    const queue = new WhisperQueue(config);
    queue.onFatalError = onFatalError;
    queue.enqueue(segments[0], 0);
    queue.enqueue(segments[1], 1);
    const transcript = queue.finalize(2);
    const settled = expect(transcript).rejects.toThrow("whisper server error"); // attach before it rejects

    // Fail both segments in lockstep, sending each retry only once both are in flight, so
    // both final attempts are pending together and both reach the fatal-error path.
    for (let attempt = 0; attempt <= VAD_CONFIG.retryAttempts; attempt++) {
      expect(pending).toHaveLength(2);
      for (const p of pending.splice(0)) p.reject(new Error("whisper server error"));
      await flush();
      if (attempt < VAD_CONFIG.retryAttempts) await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs * 2 ** attempt);
    }
    await settled;
    expect(onFatalError).toHaveBeenCalledTimes(1);
    // Later finalize() calls see the same failure
    await expect(queue.finalize(2)).rejects.toThrow("whisper server error");
  });

  it("holds every request until the ready promise (custom-server health check) resolves", async () => {
    let ready!: () => void;
    const queue = new WhisperQueue(config);
    queue.setReadyPromise(new Promise<void>((r) => (ready = r)));
    queue.enqueue(segments[0], 0);
    await flush();
    expect(transcribe).not.toHaveBeenCalled();

    ready();
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("reports progress as (completed, total) once the total is known", async () => {
    const onProgress = vi.fn();
    const queue = new WhisperQueue(config);
    queue.onProgress = onProgress;
    queue.enqueue(segments[0], 0);
    queue.enqueue(segments[1], 1);
    const transcript = queue.finalize(2);

    requestFor(1).resolve("b");
    await flush();
    requestFor(0).resolve("a");
    await transcript;
    expect(onProgress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });
});
