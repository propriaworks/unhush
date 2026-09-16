import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperQueue } from "./WhisperQueue";
import { transcribeAudioBlob } from "./transcriptionApi";

vi.mock("./transcriptionApi", () => ({
  transcribeAudioBlob: vi.fn(),
}));

const transcribeMock = vi.mocked(transcribeAudioBlob);

describe("WhisperQueue language propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes each segment's detected language to the callback while preserving text order", async () => {
    transcribeMock
      .mockResolvedValueOnce({ text: "English text", language: "en" })
      .mockResolvedValueOnce({ text: "বাংলা লেখা", language: "bn" });
    const queue = new WhisperQueue({ apiUrl: "http://localhost:8000", apiKey: "", model: "test" });
    const segments: Array<{ index: number; text: string; language: string }> = [];
    queue.onSegmentTranscribed = (index, text, _latencyMs, language) => {
      segments.push({ index, text, language });
    };

    queue.enqueue(new Blob(["first"]), 0);
    queue.enqueue(new Blob(["second"]), 1);
    await expect(queue.finalize(2)).resolves.toBe("English text বাংলা লেখা");

    expect(segments).toEqual([
      { index: 0, text: "English text", language: "en" },
      { index: 1, text: "বাংলা লেখা", language: "bn" },
    ]);
  });
});
