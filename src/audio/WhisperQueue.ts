import { VAD_CONFIG } from "./vadConfig";
import { transcribeAudioBlob, TranscriptionConfig } from "./transcriptionApi";

interface QueueEntry {
  wavBlob: Blob;
  chunkIndex: number;
}

export class WhisperQueue {
  private queue: QueueEntry[] = [];
  private inFlight = 0;
  private results = new Map<number, string>();
  private config: TranscriptionConfig;
  private expectedTotal: number | null = null;
  private resolveFinalize: ((transcript: string) => void) | null = null;
  onProgress: ((completed: number, total: number) => void) | null = null;
  onChunkTranscribed: ((chunkIndex: number, text: string) => void) | null = null;
  onLog: ((level: "info" | "warn" | "error", message: string) => void) | null = null;

  constructor(config: TranscriptionConfig) {
    this.config = config;
  }

  enqueue(wavBlob: Blob, chunkIndex: number): void {
    this.queue.push({ wavBlob, chunkIndex });
    this.processNext();
  }

  /** Signal that no more chunks will be enqueued; returns the full transcript once all complete */
  finalize(totalChunks: number): Promise<string> {
    this.expectedTotal = totalChunks;

    // If all chunks are already transcribed (e.g. single short recording)
    if (this.results.size >= totalChunks && this.inFlight === 0 && this.queue.length === 0) {
      return Promise.resolve(this.concatenateResults());
    }

    return new Promise((resolve) => {
      this.resolveFinalize = resolve;
      // Kick processing in case there are queued items
      this.processNext();
    });
  }

  private processNext(): void {
    while (this.inFlight < VAD_CONFIG.maxConcurrentRequests && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.inFlight++;
      this.transcribeWithRetry(entry.wavBlob, entry.chunkIndex, 0);
    }
  }

  private async transcribeWithRetry(
    wavBlob: Blob,
    chunkIndex: number,
    attempt: number,
  ): Promise<void> {
    try {
      const text = await transcribeAudioBlob(wavBlob, this.config);
      this.results.set(chunkIndex, text);
      this.onChunkTranscribed?.(chunkIndex, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < VAD_CONFIG.retryAttempts) {
        const delay = VAD_CONFIG.retryBaseDelayMs * Math.pow(2, attempt);
        this.onLog?.("warn", `Chunk ${chunkIndex} transcription failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${msg}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.inFlight--; // will be re-incremented via recursive call path
        this.inFlight++;
        await this.transcribeWithRetry(wavBlob, chunkIndex, attempt + 1);
        return;
      }
      this.onLog?.("error", `Chunk ${chunkIndex} transcription failed permanently after ${attempt + 1} attempts: ${msg}`);
      console.error(`Chunk ${chunkIndex} transcription failed after ${attempt + 1} attempts:`, err);
      this.results.set(chunkIndex, "[transcription failed]");
    }

    this.inFlight--;
    this.reportProgress();

    // Process more queued items
    this.processNext();

    // Check if finalization is complete
    this.checkComplete();
  }

  private reportProgress(): void {
    if (this.onProgress && this.expectedTotal !== null) {
      this.onProgress(this.results.size, this.expectedTotal);
    }
  }

  private checkComplete(): void {
    if (
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
    return ordered.join(" ");
  }
}
