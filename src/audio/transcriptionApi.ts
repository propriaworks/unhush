export const TRANSCRIPTION_DEFAULT_CUSTOM_URL = "http://localhost:8000/v1/audio/transcriptions";

export interface TranscriptionConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

export function getTranscriptionConfig(): TranscriptionConfig {
  const provider = localStorage.getItem("wisper_provider") || "groq";

  if (provider === "groq") {
    return {
      apiKey: localStorage.getItem("wisper_groq_key") || "",
      apiUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
    };
  } else if (provider === "openai") {
    return {
      apiKey: localStorage.getItem("wisper_openai_key") || "",
      apiUrl: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
    };
  } else {
    return {
      apiKey: localStorage.getItem("wisper_custom_key") || "",
      apiUrl: localStorage.getItem("wisper_custom_url") || TRANSCRIPTION_DEFAULT_CUSTOM_URL,
      model: localStorage.getItem("wisper_custom_model") || "",
    };
  }
}

export function validateTranscriptionConfig(config: TranscriptionConfig): string | null {
  const provider = localStorage.getItem("wisper_provider") || "groq";

  if (provider === "custom" && !(config.apiUrl && config.model)) {
    return "API URL or model is unset.\nOpen Settings from tray.";
  } else if (provider !== "custom" && !config.apiKey) {
    return "No API key.\nOpen Settings from tray.";
  }
  return null;
}

export async function transcribeAudioBlob(
  audioBlob: Blob,
  config: TranscriptionConfig,
): Promise<string> {
  const provider = localStorage.getItem("wisper_provider") || "groq";
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
