import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperQueue } from "./WhisperQueue";
import { transcribeAudioBlob, TranscriptionTimeoutError, TRANSCRIPTION_UNREACHABLE_MSG } from "./transcriptionApi";
import { VAD_CONFIG } from "./vadConfig";

vi.mock("./transcriptionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcriptionApi")>()),
  transcribeAudioBlob: vi.fn(),
}));
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

  it("fails at once, without sending or retrying, when the server is known to be unreachable", async () => {
    const checkReachable = vi.fn(async () => false);
    const queue = new WhisperQueue(config);
    queue.checkReachable = checkReachable;
    queue.enqueue(segments[0], 0);
    const transcript = queue.finalize(1);

    await expect(transcript).rejects.toThrow(TRANSCRIPTION_UNREACHABLE_MSG);
    expect(transcribe).not.toHaveBeenCalled();
    expect(checkReachable).toHaveBeenCalledTimes(1);
  });

  it("checks reachability again before each retry", async () => {
    const checkReachable = vi.fn(async () => true);
    const queue = new WhisperQueue(config);
    queue.checkReachable = checkReachable;
    queue.enqueue(segments[0], 0);
    const transcript = queue.finalize(1);
    const settled = expect(transcript).rejects.toThrow(TRANSCRIPTION_UNREACHABLE_MSG);
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);

    // The first attempt fails; by the retry, the health check has found the server down.
    checkReachable.mockResolvedValue(false);
    pending.pop()!.reject(new Error("transcription server error"));
    await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs);
    await settled;
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(checkReachable).toHaveBeenCalledTimes(2);
  });

  it("retries a timed-out segment with the shorter timeout, reporting the retry while it runs", async () => {
    const onTimeoutRetrying = vi.fn();
    const queue = new WhisperQueue(config);
    queue.onTimeoutRetrying = onTimeoutRetrying;
    queue.enqueue(segments[0], 0);
    const transcript = queue.finalize(1);
    expect(transcribe.mock.calls[0][2]).toBeUndefined(); // the default (long) timeout

    pending.pop()!.reject(new TranscriptionTimeoutError("timed out"));
    await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs);
    expect(onTimeoutRetrying.mock.calls).toEqual([[true]]);
    expect(transcribe.mock.calls[1][2]).toBe(VAD_CONFIG.retryAfterTimeoutMs);

    // Later retries of that segment keep the short timeout, whatever they fail with
    pending.pop()!.reject(new Error("transcription server error"));
    await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs * 2);
    expect(transcribe.mock.calls[2][2]).toBe(VAD_CONFIG.retryAfterTimeoutMs);

    pending.pop()!.resolve("done");
    await expect(transcript).resolves.toBe("done");
    expect(onTimeoutRetrying.mock.calls).toEqual([[true], [false]]);
  });

  it("does not shorten the timeout for retries after other failures", async () => {
    const queue = new WhisperQueue(config);
    queue.enqueue(segments[0], 0);
    pending.pop()!.reject(new Error("transcription server error"));
    await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs);
    expect(transcribe.mock.calls[1][2]).toBeUndefined();
  });

  it("cancel() rejects finalize at once, aborts requests in flight, and neither retries nor reports", async () => {
    const onFatalError = vi.fn();
    const onLog = vi.fn();
    const queue = new WhisperQueue(config);
    queue.onFatalError = onFatalError;
    queue.onLog = onLog;
    queue.enqueue(segments[0], 0);
    const transcript = queue.finalize(1);
    const signal = transcribe.mock.calls[0][3]!;

    queue.cancel();
    await expect(transcript).rejects.toThrow("transcription cancelled");
    expect(signal.aborted).toBe(true);

    pending.pop()!.reject(new DOMException("aborted", "AbortError")); // as the real fetch would
    await vi.advanceTimersByTimeAsync(VAD_CONFIG.retryBaseDelayMs * 4);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onFatalError).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
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
