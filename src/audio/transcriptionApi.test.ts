import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_DEFAULT_CUSTOM_URL,
  getTranscriptionConfig,
  transcribeAudioBlob,
  validateTranscriptionConfig,
} from "./transcriptionApi";
import { PROVIDER_BASE_URLS, TRANSCRIPTIONS_PATH } from "./customModelService";
import { makeFetchMock, type FetchResult } from "./testFetchMock";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTranscriptionConfig", () => {
  beforeEach(() => {
    localStorage.setItem("unhush_groq_key", "groq-key");
    localStorage.setItem("unhush_openai_key", "openai-key");
    localStorage.setItem("unhush_custom_key", "custom-key");
  });

  it("defaults to Groq when no provider is set", () => {
    expect(getTranscriptionConfig()).toEqual({
      apiKey: "groq-key",
      apiUrl: `${PROVIDER_BASE_URLS.groq}${TRANSCRIPTIONS_PATH}`,
      model: "whisper-large-v3-turbo",
    });
  });

  it("uses OpenAI's URL, model and key", () => {
    localStorage.setItem("unhush_provider", "openai");
    expect(getTranscriptionConfig()).toEqual({
      apiKey: "openai-key",
      apiUrl: `${PROVIDER_BASE_URLS.openai}${TRANSCRIPTIONS_PATH}`,
      model: "whisper-1",
    });
  });

  it("builds a custom URL from the server prefix, with the custom key and model", () => {
    localStorage.setItem("unhush_provider", "custom");
    localStorage.setItem("unhush_custom_url", "http://gpu-box:8000/");
    localStorage.setItem("unhush_custom_model", "whisper-small");
    expect(getTranscriptionConfig()).toEqual({
      apiKey: "custom-key",
      apiUrl: `http://gpu-box:8000${TRANSCRIPTIONS_PATH}`,
      model: "whisper-small",
    });
  });

  it("doesn't double the path for a legacy full-endpoint custom URL", () => {
    localStorage.setItem("unhush_provider", "custom");
    localStorage.setItem("unhush_custom_url", `http://gpu-box:8000${TRANSCRIPTIONS_PATH}`);
    expect(getTranscriptionConfig().apiUrl).toBe(`http://gpu-box:8000${TRANSCRIPTIONS_PATH}`);
  });

  it("falls back to the default custom server and an empty model when unset", () => {
    localStorage.setItem("unhush_provider", "custom");
    const config = getTranscriptionConfig();
    expect(config.apiUrl).toBe(`${TRANSCRIPTION_DEFAULT_CUSTOM_URL}${TRANSCRIPTIONS_PATH}`);
    expect(config.model).toBe("");
  });
});

describe("validateTranscriptionConfig", () => {
  // Validates the config the current settings produce, the way callers use it
  const validate = () => validateTranscriptionConfig(getTranscriptionConfig());

  it.each(["groq", "openai"])("%s: missing API key → config; key present → valid", (provider) => {
    localStorage.setItem("unhush_provider", provider);
    expect(validate()?.reasonKey).toBe("config");
    localStorage.setItem(`unhush_${provider}_key`, "k");
    expect(validate()).toBeNull();
  });

  it("custom: missing model → config", () => {
    localStorage.setItem("unhush_provider", "custom");
    localStorage.setItem("unhush_custom_url", "http://localhost:8000");
    expect(validate()?.reasonKey).toBe("config");
  });

  it.each(["localhost:8000", "not a url", "ftp://localhost:8000"])("custom: URL %j → badurl", (url) => {
    localStorage.setItem("unhush_provider", "custom");
    localStorage.setItem("unhush_custom_url", url);
    localStorage.setItem("unhush_custom_model", "whisper-small");
    expect(validate()?.reasonKey).toBe("badurl");
  });

  it("custom: valid URL and model, no key needed → valid", () => {
    localStorage.setItem("unhush_provider", "custom");
    localStorage.setItem("unhush_custom_url", "http://localhost:8000");
    localStorage.setItem("unhush_custom_model", "whisper-small");
    expect(validate()).toBeNull();
  });
});

describe("transcribeAudioBlob", () => {
  const config = { apiUrl: "http://localhost:8000/v1/audio/transcriptions", apiKey: "k", model: "m" };
  const audio = new Blob(["x"], { type: "audio/wav" });

  const respondWith = (result: FetchResult) => {
    const fetchMock = makeFetchMock(() => result);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("returns the trimmed response text", async () => {
    respondWith({ ok: true, text: async () => "  hello world \n" });
    await expect(transcribeAudioBlob(audio, config)).resolves.toBe("hello world");
  });

  it.each([
    ["audio/ogg;codecs=opus", "recording.ogg"],
    ["audio/webm", "recording.webm"],
    ["audio/wav", "recording.wav"],
    ["", "recording.wav"],
  ])("names a %j blob %s", async (type, filename) => {
    const fetchMock = respondWith({ ok: true });
    await transcribeAudioBlob(new Blob(["x"], { type }), config);
    const body = fetchMock.mock.calls[0][1]!.body as FormData;
    expect((body.get("file") as File).name).toBe(filename);
    expect(body.get("model")).toBe("m");
  });

  it("sends an Authorization header only when there is a key", async () => {
    const fetchMock = respondWith({ ok: true });
    await transcribeAudioBlob(audio, config);
    await transcribeAudioBlob(audio, { ...config, apiKey: "" });
    const headers = fetchMock.mock.calls.map(([, init]) => init!.headers as Record<string, string>);
    expect(headers[0].Authorization).toBe("Bearer k");
    expect(headers[1]).not.toHaveProperty("Authorization");
  });

  describe("error messages", () => {
    it.each([
      ["custom", "whisper server is unreachable"],
      ["groq", "network error"],
    ])("%s: a failed connection → %j", async (provider, message) => {
      localStorage.setItem("unhush_provider", provider);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      await expect(transcribeAudioBlob(audio, config)).rejects.toThrow(message);
    });

    it("passes the API's own error message through, whatever the status", async () => {
      respondWith({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid API Key" } }) });
      await expect(transcribeAudioBlob(audio, config)).rejects.toThrow("Invalid API Key");
    });

    // provider, status → message, for responses without an API error message
    it.each([
      ["groq", 401, "bad groq API key"],
      ["openai", 403, "bad openai API key"],
      ["custom", 401, "bad custom API key"],
      ["groq", 429, "transcription was rate-limited"],
      ["custom", 404, "bad whisper URL or model name"],
      ["custom", 405, "bad whisper URL or model name"],
      ["groq", 404, "transcription API error 404"],
      ["custom", 500, "whisper server error"],
      ["openai", 503, "service-side transcription error"],
      ["custom", 400, "transcription API error 400"],
    ])("%s: HTTP %i → %j", async (provider, status, message) => {
      localStorage.setItem("unhush_provider", provider);
      respondWith({ ok: false, status, json: async () => { throw new SyntaxError("not JSON"); } });
      await expect(transcribeAudioBlob(audio, config)).rejects.toThrow(message);
    });
  });
});
