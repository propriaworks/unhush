import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_DEFAULT_CUSTOM_URL,
  LLM_DEFAULT_MODELS,
  LLM_DEFAULT_SYSTEM_PROMPT,
  LLM_FINAL_INSTRUCTIONS,
  getLLMConfig,
  postProcessTranscript,
  validateLLMConfig,
  type LLMConfig,
} from "./llmApi";
import { CHAT_COMPLETIONS_PATH, PROVIDER_BASE_URLS } from "./customModelService";
import { makeFetchMock, type FetchResult } from "./testFetchMock";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLLMConfig", () => {
  it("returns null when formatting is off (the default)", () => {
    expect(getLLMConfig()).toBeNull();
    localStorage.setItem("unhush_llm_provider", "none");
    expect(getLLMConfig()).toBeNull();
  });

  it.each(["groq", "openai"] as const)("%s: provider URL, its key, and its default model", (provider) => {
    localStorage.setItem("unhush_llm_provider", provider);
    localStorage.setItem(`unhush_${provider}_key`, `${provider}-key`);
    const config = getLLMConfig()!;
    expect(config.apiUrl).toBe(`${PROVIDER_BASE_URLS[provider]}${CHAT_COMPLETIONS_PATH}`);
    expect(config.apiKey).toBe(`${provider}-key`);
    expect(config.model).toBe(LLM_DEFAULT_MODELS[provider]);
  });

  it("uses a stored model over the provider default", () => {
    localStorage.setItem("unhush_llm_provider", "groq");
    localStorage.setItem("unhush_llm_model_groq", "some-other-model");
    expect(getLLMConfig()!.model).toBe("some-other-model");
  });

  it("custom: builds the URL from the server prefix, with the custom key and model", () => {
    localStorage.setItem("unhush_llm_provider", "custom");
    localStorage.setItem("unhush_llm_custom_url", "http://gpu-box:11434/");
    localStorage.setItem("unhush_llm_custom_key", "custom-key");
    localStorage.setItem("unhush_llm_model_custom", "qwen3:8b");
    const config = getLLMConfig()!;
    expect(config.apiUrl).toBe(`http://gpu-box:11434${CHAT_COMPLETIONS_PATH}`);
    expect(config.apiKey).toBe("custom-key");
    expect(config.model).toBe("qwen3:8b");
  });

  it("custom: doesn't double the path for a legacy full-endpoint URL", () => {
    localStorage.setItem("unhush_llm_provider", "custom");
    localStorage.setItem("unhush_llm_custom_url", `http://gpu-box:11434${CHAT_COMPLETIONS_PATH}`);
    expect(getLLMConfig()!.apiUrl).toBe(`http://gpu-box:11434${CHAT_COMPLETIONS_PATH}`);
  });

  it("custom: falls back to the default server and an empty model when unset", () => {
    localStorage.setItem("unhush_llm_provider", "custom");
    const config = getLLMConfig()!;
    expect(config.apiUrl).toBe(`${LLM_DEFAULT_CUSTOM_URL}${CHAT_COMPLETIONS_PATH}`);
    expect(config.model).toBe("");
  });

  it("uses the default prompts and length limits unless overridden", () => {
    localStorage.setItem("unhush_llm_provider", "groq");
    expect(getLLMConfig()).toMatchObject({
      systemPrompt: LLM_DEFAULT_SYSTEM_PROMPT,
      finalInstructions: LLM_FINAL_INSTRUCTIONS,
      lengthMultiplier: 1.1,
      lengthFloor: 20,
    });

    localStorage.setItem("unhush_llm_system_prompt", "custom system");
    localStorage.setItem("unhush_llm_final_instructions", "custom final");
    localStorage.setItem("unhush_llm_length_multiplier", "1.5");
    localStorage.setItem("unhush_llm_excess_length_floor", "40");
    expect(getLLMConfig()).toMatchObject({
      systemPrompt: "custom system",
      finalInstructions: "custom final",
      lengthMultiplier: 1.5,
      lengthFloor: 40,
    });
  });
});

describe("validateLLMConfig", () => {
  const validate = () => validateLLMConfig(getLLMConfig()!);

  it.each(["groq", "openai"])("%s: missing API key → config; key present → valid", (provider) => {
    localStorage.setItem("unhush_llm_provider", provider);
    expect(validate()?.reasonKey).toBe("config");
    localStorage.setItem(`unhush_${provider}_key`, "k");
    expect(validate()).toBeNull();
  });

  it("custom: missing model → config", () => {
    localStorage.setItem("unhush_llm_provider", "custom");
    localStorage.setItem("unhush_llm_custom_url", "http://localhost:11434");
    expect(validate()?.reasonKey).toBe("config");
  });

  it.each(["localhost:11434", "not a url", "ftp://localhost:11434"])("custom: URL %j → badurl", (url) => {
    localStorage.setItem("unhush_llm_provider", "custom");
    localStorage.setItem("unhush_llm_custom_url", url);
    localStorage.setItem("unhush_llm_model_custom", "qwen3:8b");
    expect(validate()?.reasonKey).toBe("badurl");
  });

  it("custom: valid URL and model, no key needed → valid", () => {
    localStorage.setItem("unhush_llm_provider", "custom");
    localStorage.setItem("unhush_llm_custom_url", "http://localhost:11434");
    localStorage.setItem("unhush_llm_model_custom", "qwen3:8b");
    expect(validate()).toBeNull();
  });
});

describe("postProcessTranscript", () => {
  const config: LLMConfig = {
    provider: "custom",
    apiKey: "",
    apiUrl: `http://localhost:11434${CHAT_COMPLETIONS_PATH}`,
    model: "qwen3:8b",
    systemPrompt: "sys",
    finalInstructions: "final",
    lengthMultiplier: 1.1,
    lengthFloor: 20,
  };

  const respondWith = (result: FetchResult) => {
    const fetchMock = makeFetchMock(() => result);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const reply = (content: unknown, finish_reason?: string) =>
    async () => ({ choices: [{ message: { content }, finish_reason }] });
  const sentBody = (fetchMock: ReturnType<typeof respondWith>) =>
    JSON.parse(fetchMock.mock.calls[0][1]!.body as string);

  it("returns the trimmed content", async () => {
    respondWith({ ok: true, json: reply("  Hello, world.\n") });
    await expect(postProcessTranscript("hello world", config)).resolves.toMatchObject({ content: "Hello, world." });
  });

  it("refuses to send without a model", async () => {
    const fetchMock = respondWith({ ok: true, json: reply("x") });
    await expect(postProcessTranscript("hi", { ...config, model: "" })).rejects.toThrow("LLM model is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["custom", "server unreachable"],
    ["groq", "network error"],
  ] as const)("%s: a failed connection → %j", async (provider, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(postProcessTranscript("hi", { ...config, provider })).rejects.toThrow(message);
  });

  it("reports the API's error message with the endpoint and model", async () => {
    respondWith({ ok: false, status: 404, json: async () => ({ error: { message: "model 'qwen3:8b' not found" } }) });
    await expect(postProcessTranscript("hi", config)).rejects.toThrow(
      `model 'qwen3:8b' not found [POST ${config.apiUrl}, model: qwen3:8b]`,
    );
  });

  it("falls back to the HTTP status when the error body has no message", async () => {
    respondWith({ ok: false, status: 502, statusText: "Bad Gateway", json: async () => { throw new SyntaxError(); } });
    await expect(postProcessTranscript("hi", config)).rejects.toThrow("HTTP 502: Bad Gateway");
  });

  it.each([
    ["empty", reply("", "length")],
    ["whitespace-only", reply("  \n", "stop")],
    ["missing", async () => ({ choices: [] })],
  ])("throws on %s content, citing the finish reason", async (_label, json) => {
    respondWith({ ok: true, json });
    await expect(postProcessTranscript("hi", config)).rejects.toThrow(/LLM returned empty response.*finish_reason/);
  });

  it("caps max_tokens at 2× the estimated input tokens, with a floor of 256", async () => {
    const fetchMock = respondWith({ ok: true, json: reply("x") });
    await postProcessTranscript("short", config);
    expect(sentBody(fetchMock).max_tokens).toBe(256);

    fetchMock.mockClear();
    await postProcessTranscript("a".repeat(4000), config); // ~1000 tokens
    expect(sentBody(fetchMock).max_tokens).toBe(2000);
  });

  it("sends the system prompt, and the transcript wrapped with the final instructions", async () => {
    const fetchMock = respondWith({ ok: true, json: reply("x") });
    await postProcessTranscript("hello", config);
    expect(sentBody(fetchMock).messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "<transcript>\nhello\n</transcript>\n\nfinal" },
    ]);
  });
});
