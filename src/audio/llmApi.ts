export type LLMProvider = "none" | "groq" | "openai" | "custom";

export interface LLMConfig {
  provider: "groq" | "openai" | "custom";
  apiKey: string;
  apiUrl: string;
  model: string;
  systemPrompt: string;
  finalInstructions: string;
  lengthMultiplier: number;
  lengthFloor: number;
}

export const LLM_DEFAULT_MODELS: Record<"groq" | "openai", string> = {
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4.1-mini",
};

export const LLM_DEFAULT_CUSTOM_URL = "http://localhost:11434/v1/chat/completions";

export const SPLIT_POINT_MARKER = " <split_point/> ";

export const LLM_DEFAULT_SYSTEM_PROMPT =
  `You are a dictation transcript formatter. Output ONLY the cleaned transcript, nothing else.
The goal is to accurately convey what the speaker actually said, not to improve it.

Rules (in priority order):
1. NEVER add, remove, or change the meaning of any content
2. Fix punctuation, capitalization, and grammar
3. Fix obvious mishearings: wrong homophones, misspelled proper nouns
4. Output results in the original language; do not translate
5. Remove filler words: um, uh, like, you know, so yeah, etc
6. Resolve verbal corrections: "the red — or rather the blue one" → "the blue one"
7. Convert spoken symbols when unambiguous, including into unicode: "slash help" → "/help", "dot com" → ".com", "hashtag" → "#"
8. Remove all <split_point/> markers — these are (arbitrary) transcription boundaries, not content
9. Even if text starts / ends abruptly or seems incomplete, leave it as-is; it may merely be a part of a larger whole`
// Optional additions to consider:
// #10. Write numbers, dates, and times in their conventional written form
//   - This can have unintended consequences even when done right (eg, a pin code or phone number written with a comma to look like a number)
// Modify #7 to include things like "wink emoji" → 😉
//   - But even large models seem to have poor mappings into unicode chars
// Formatting such as lists into markdown or as bullets (e.g.)
// #8 explain that text around the transcription boundaries may need to be smoothly joined


export const LLM_FINAL_INSTRUCTIONS = // placed after the xml-enclosed transcript
  'Output the cleaned transcript only. No commentary, no explanations, no preamble.'

export function getLLMConfig(): LLMConfig | null {
  const provider = (localStorage.getItem("wisper_llm_provider") || "none") as LLMProvider;
  if (provider === "none") return null;

  const getApiKey = () => {
    if (provider === "groq") return localStorage.getItem("wisper_groq_key") || "";
    if (provider === "openai") return localStorage.getItem("wisper_openai_key") || "";
    return localStorage.getItem("wisper_llm_custom_key") || "";
  };

  const getApiUrl = () => {
    if (provider === "groq") return "https://api.groq.com/openai/v1/chat/completions";
    if (provider === "openai") return "https://api.openai.com/v1/chat/completions";
    return localStorage.getItem("wisper_llm_custom_url") || LLM_DEFAULT_CUSTOM_URL;
  };

  const getModel = () => {
    const stored = localStorage.getItem(`wisper_llm_model_${provider}`);
    if (stored) return stored;
    if (provider === "groq" || provider === "openai") return LLM_DEFAULT_MODELS[provider];
    return "";
  };

  const systemPrompt =
    localStorage.getItem("wisper_llm_system_prompt") || LLM_DEFAULT_SYSTEM_PROMPT;

  const finalInstructions =
    localStorage.getItem("wisper_llm_final_instructions") || LLM_FINAL_INSTRUCTIONS;

  return {
    provider,
    apiKey: getApiKey(),
    apiUrl: getApiUrl(),
    model: getModel(),
    systemPrompt,
    finalInstructions,
    lengthMultiplier: parseFloat(localStorage.getItem("wisper_llm_length_multiplier") || "1.1"),
    lengthFloor: parseInt(localStorage.getItem("wisper_llm_excess_length_floor") || "20", 10),
  };
}

export function makeUserPrompt(transcript: string, config: LLMConfig): string {
  return `<transcript>\n${transcript}\n</transcript>\n\n${config.finalInstructions}`
}

export async function postProcessTranscript(
  transcript: string,
  config: LLMConfig,
): Promise<{ content: string; latencyMs: number }> {
  if (!config.model) {
    throw new Error(`LLM model is not set (URL: ${config.apiUrl})`);
  }
  if (!config.apiUrl) {
    throw new Error(`LLM API URL is not set (model: ${config.model})`);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  // 2× estimated input tokens — generous headroom to avoid cutting legitimate output,
  // while still stopping runaway generation. ~4 chars/token for English; floor at 256.
  const maxTokens = Math.max(256, Math.ceil(transcript.length / 4) * 2);

  const t0 = Date.now();
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: makeUserPrompt(transcript, config) },
      ],
    }),
  }).catch(() => { throw new Error(config.provider === "custom" ? "server unreachable" : "network error"); });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`) +
        ` [POST ${config.apiUrl}, model: ${config.model}]`,
    );
  }

  const data = await response.json();
  const latencyMs = Date.now() - t0;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new Error(`LLM returned empty response [model: ${config.model}, finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"}]`);
  }
  return { content, latencyMs };
}
