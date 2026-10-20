import { VAD_CONFIG } from "./vadConfig";
import {
  transcribeAudioBlob, TranscriptionConfig, TranscriptionTimeoutError, TRANSCRIPTION_UNREACHABLE_MSG,
} from "./transcriptionApi";

interface QueueEntry {
  wavBlob: Blob;
  segmentIndex: number;
}

export class WhisperQueue {
  private queue: QueueEntry[] = [];
  private inFlight = 0;
  private results = new Map<number, string>();
  private config: TranscriptionConfig;
  private expectedTotal: number | null = null;
  private separator = " ";
  private resolveFinalize: ((transcript: string) => void) | null = null;
  private rejectFinalize: ((err: Error) => void) | null = null;
  private failed = false;
  private firstError: string | null = null;
  onProgress: ((completed: number, total: number) => void) | null = null;
  onSegmentTranscribed: ((segmentIndex: number, text: string, latencyMs: number) => void) | null = null;
  onLog: ((level: "info" | "warn" | "error", message: string) => void) | null = null;
  onFatalError: ((err: Error) => void) | null = null;
  // Consulted before every attempt. False fails the segment at once, without sending it or
  // retrying: a server the health check has just found down would only make each attempt
  // wait out a timeout.
  checkReachable: (() => Promise<boolean>) | null = null;
  // Called with true when some segment starts retrying after a timeout, and false once no
  // segment is any longer, so the bar can say why the wait is long.
  onTimeoutRetrying: ((retrying: boolean) => void) | null = null;
  private timeoutRetries = 0; // segments currently retrying after a timeout
  private abort = new AbortController(); // aborts requests in flight on cancel()
  private readyPromise: Promise<void> | null = null;

  setReadyPromise(p: Promise<void>): void {
    this.readyPromise = p;
  }

  constructor(config: TranscriptionConfig) {
    this.config = config;
  }

  /** The user gave up on this transcript: abort requests in flight, send no more, and reject
   * finalize(). Not reported through onFatalError, since nothing went wrong. */
  cancel(): void {
    if (this.failed) return;
    this.failed = true;
    this.firstError = "transcription cancelled";
    this.abort.abort();
    this.rejectFinalize?.(new Error(this.firstError));
    this.resolveFinalize = null;
    this.rejectFinalize = null;
  }

  enqueue(wavBlob: Blob, segmentIndex: number): void {
    this.queue.push({ wavBlob, segmentIndex });
    this.processNext();
  }

  /** Signal that no more segments will be enqueued; returns the full transcript once all complete */
  finalize(totalSegments: number, separator = " "): Promise<string> {
    this.expectedTotal = totalSegments;
    this.separator = separator;

    if (this.firstError) return Promise.reject(new Error(this.firstError));

    // If all segments are already transcribed (e.g. single short recording)
    if (this.results.size >= totalSegments && this.inFlight === 0 && this.queue.length === 0) {
      return Promise.resolve(this.concatenateResults());
    }

    return new Promise((resolve, reject) => {
      this.resolveFinalize = resolve;
      this.rejectFinalize = reject;
      // Kick processing in case there are queued items
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.failed) return;
    while (this.inFlight < VAD_CONFIG.maxConcurrentRequests && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.inFlight++;
      this.transcribeWithRetry(entry.wavBlob, entry.segmentIndex, 0);
    }
  }

  private async transcribeWithRetry(
    wavBlob: Blob,
    segmentIndex: number,
    attempt: number,
    afterTimeout = false, // an earlier attempt on this segment timed out
  ): Promise<void> {
    if (this.failed) { this.inFlight--; return; }
    if (this.readyPromise) await this.readyPromise;
    let unreachable = false;
    try {
      if (this.checkReachable && !(await this.checkReachable())) {
        unreachable = true;
        throw new Error(TRANSCRIPTION_UNREACHABLE_MSG);
      }
      const t0 = Date.now();
      const text = await transcribeAudioBlob(wavBlob, this.config,
        afterTimeout ? VAD_CONFIG.retryAfterTimeoutMs : undefined, this.abort.signal);
      const latencyMs = Date.now() - t0;
      if (!this.failed) {
        this.results.set(segmentIndex, text);
        this.onSegmentTranscribed?.(segmentIndex, text, latencyMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Once cancelled, or failed by another segment, there is nothing left to retry for or report.
      if (!this.failed && !unreachable && attempt < VAD_CONFIG.retryAttempts) {
        const delay = VAD_CONFIG.retryBaseDelayMs * Math.pow(2, attempt);
        this.onLog?.("warn", `Segment ${segmentIndex} transcription failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${msg}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.inFlight--; // will be re-incremented via recursive call path
        this.inFlight++;
        // The recursive call runs this segment's remaining attempts to the end, so the count
        // drops once it has either succeeded or failed for good.
        const firstTimeout = !afterTimeout && err instanceof TranscriptionTimeoutError;
        if (firstTimeout && this.timeoutRetries++ === 0) this.onTimeoutRetrying?.(true);
        await this.transcribeWithRetry(wavBlob, segmentIndex, attempt + 1, afterTimeout || firstTimeout);
        if (firstTimeout && --this.timeoutRetries === 0) this.onTimeoutRetrying?.(false);
        return;
      }
      if (!this.failed) {
        this.onLog?.("error", `Segment ${segmentIndex} transcription failed permanently after ${attempt + 1} attempts: ${msg}`);
        console.error(`Segment ${segmentIndex} transcription failed after ${attempt + 1} attempts:`, err);
        this.failed = true;
        this.firstError = msg;
        const fatal = new Error(msg);
        this.rejectFinalize?.(fatal);
        this.resolveFinalize = null;
        this.rejectFinalize = null;
        this.onFatalError?.(fatal);
      }
    }

    this.inFlight--;
    this.reportProgress();
    this.processNext();
    this.checkComplete();
  }

  private reportProgress(): void {
    if (this.onProgress && this.expectedTotal !== null) {
      this.onProgress(this.results.size, this.expectedTotal);
    }
  }

  private checkComplete(): void {
    if (
      !this.failed &&
      this.resolveFinalize &&
      this.expectedTotal !== null &&
      this.results.size >= this.expectedTotal &&
      this.inFlight === 0 &&
      this.queue.length === 0
    ) {
      this.resolveFinalize(this.concatenateResults());
      this.resolveFinalize = null;
    }
  }

  private concatenateResults(): string {
    const ordered: string[] = [];
    const count = this.expectedTotal ?? this.results.size;
    for (let i = 0; i < count; i++) {
      const text = this.results.get(i);
      if (text) {
        ordered.push(text);
      }
    }
    return ordered.join(this.separator);
  }
}
