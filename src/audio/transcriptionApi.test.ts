import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudioBlob, TranscriptionConfig } from "./transcriptionApi";

const config: TranscriptionConfig = {
  apiUrl: "http://localhost:8000/v1/audio/transcriptions",
  apiKey: "",
  model: "test-model",
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("unhush_provider", "custom");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcription language metadata", () => {
  it("reads the language header from a plain-text response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("বাংলা transcript", {
      status: 200,
      headers: { "content-type": "text/plain", "X-Unhush-Language": "ben" },
    }));

    await expect(transcribeAudioBlob(new Blob(["audio"]), config)).resolves.toEqual({
      text: "বাংলা transcript",
      language: "bn",
    });
  });

  it("accepts language metadata from JSON-compatible services", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      text: "यह हिन्दी है",
      language_code: "hi-IN",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(transcribeAudioBlob(new Blob(["audio"]), config)).resolves.toEqual({
      text: "यह हिन्दी है",
      language: "hi",
    });
  });

  it("falls back to visible script when a service returns only text", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("এটি বাংলা", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await expect(transcribeAudioBlob(new Blob(["audio"]), config)).resolves.toEqual({
      text: "এটি বাংলা",
      language: "bn",
    });
  });
});
