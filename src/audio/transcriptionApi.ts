export const TRANSCRIPTION_DEFAULT_CUSTOM_URL = "http://localhost:8000/v1/audio/transcriptions";

import { PROVIDER_BASE_URLS, isValidHttpUrl } from "./customModelService";

export interface TranscriptionConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

/** reasonKey distinguishes causes that need separate tray messages (see main.cjs
 * WARNING_MESSAGES) — "config" for unset fields, "badurl" for a malformed custom URL. */
export interface ConfigValidationError {
  reasonKey: "config" | "badurl";
  message: string;
}

export function getTranscriptionConfig(): TranscriptionConfig {
  const provider = localStorage.getItem("unhush_provider") || "groq";

  if (provider === "groq") {
    return {
      apiKey: localStorage.getItem("unhush_groq_key") || "",
      apiUrl: `${PROVIDER_BASE_URLS.groq}/v1/audio/transcriptions`,
      model: "whisper-large-v3-turbo",
    };
  } else if (provider === "openai") {
    return {
      apiKey: localStorage.getItem("unhush_openai_key") || "",
      apiUrl: `${PROVIDER_BASE_URLS.openai}/v1/audio/transcriptions`,
      model: "whisper-1",
    };
  } else {
    return {
      apiKey: localStorage.getItem("unhush_custom_key") || "",
      apiUrl: localStorage.getItem("unhush_custom_url") || TRANSCRIPTION_DEFAULT_CUSTOM_URL,
      model: localStorage.getItem("unhush_custom_model") || "",
    };
  }
}

export function validateTranscriptionConfig(config: TranscriptionConfig): ConfigValidationError | null {
  const provider = localStorage.getItem("unhush_provider") || "groq";

  if (provider === "custom") {
    if (!(config.apiUrl && config.model)) {
      return { reasonKey: "config", message: "API URL or model is unset.\nOpen Settings from tray." };
    }
    if (!isValidHttpUrl(config.apiUrl)) {
      return { reasonKey: "badurl", message: "API URL is invalid.\nOpen Settings from tray." };
    }
  } else if (!config.apiKey) {
    return { reasonKey: "config", message: "No API key.\nOpen Settings from tray." };
  }
  return null;
}

export async function transcribeAudioBlob(
  audioBlob: Blob,
  config: TranscriptionConfig,
): Promise<string> {
  const provider = localStorage.getItem("unhush_provider") || "groq";
  const formData = new FormData();

  // Determine file extension from blob type
  let extension = "wav";
  if (audioBlob.type.includes("ogg")) extension = "ogg";
  else if (audioBlob.type.includes("webm")) extension = "webm";

  formData.append("file", audioBlob, `recording.${extension}`);
  formData.append("response_format", "text");
  formData.append("model", config.model);

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(config.apiUrl, {
      method: "POST",
      headers,
      body: formData,
  }).catch(() => {
    throw new Error(provider === "custom" ? "whisper server is unreachable" : "network error");
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const apiMsg: string | undefined = errorData.error?.message;
    const status = response.status;
    if (apiMsg) {
      throw new Error(apiMsg);
    } else if (status === 401 || status === 403) {
      throw new Error(`bad ${provider} API key`);
    } else if (status === 429) {
      throw new Error("transcription was rate-limited");
    } else if (provider === "custom" && (status === 404 || status === 405)) {
      throw new Error("bad whisper URL or model name");
    } else if (status >= 500) {
      throw new Error(provider === "custom" ? "whisper server error" : "service-side transcription error");
    } else {
      throw new Error(`transcription API error ${status}`);
    }
  }

  const text = await response.text();
  return text.trim();
}
