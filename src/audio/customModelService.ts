// ── Types ──────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

// ── Module-level state ─────────────────────────────────────────────────────────

let healthCheckedThisSession = false;

// Keyed by "baseUrl:kind" (e.g. "http://localhost:8080:transcription")
const lastWarmupTime = new Map<string, number>();
const lastWarmupModel = new Map<string, string>();

// ── Helpers ────────────────────────────────────────────────────────────────────

function getBaseUrl(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).origin;
  } catch {
    return endpointUrl;
  }
}

/** GET {baseUrl}/v1/models — returns null on any failure. */
export async function fetchModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelsResponse | null> {
  const url = `${baseUrl}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as ModelsResponse;
  } catch {
    return null;
  }
}

function generateSilentWav(): Blob {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * 0.1); // 0.1s
  const dataLength = numSamples * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);
  // PCM data: ArrayBuffer is zero-initialised = silence
  return new Blob([buffer], { type: "audio/wav" });
}

async function warmUpTranscription(
  baseUrl: string,
  apiKey: string,
  model: string,
  log: LogFn,
): Promise<void> {
  const url = `${baseUrl}/v1/audio/transcriptions`;
  const formData = new FormData();
  formData.append("file", generateSilentWav(), "warmup.wav");
  formData.append("model", model);
  formData.append("response_format", "text");
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const t0 = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
    const latencyMs = Date.now() - t0;
    if (response.ok) {
      log("info", `Transcription warm-up succeeded for ${baseUrl} [${latencyMs}ms]`);
    } else {
      log("warn", `Transcription warm-up returned ${response.status} for ${baseUrl} [${latencyMs}ms]`);
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    log("warn", `Transcription warm-up failed for ${baseUrl} [${latencyMs}ms]: ${err instanceof Error ? err.message : err}`);
  }
}

async function warmUpLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  log: LogFn,
): Promise<void> {
  const url = `${baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const t0 = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const latencyMs = Date.now() - t0;
    if (response.ok) {
      log("info", `LLM warm-up succeeded for ${baseUrl} [${latencyMs}ms]`);
    } else {
      log("warn", `LLM warm-up returned ${response.status} for ${baseUrl} [${latencyMs}ms]`);
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    log("warn", `LLM warm-up failed for ${baseUrl} [${latencyMs}ms]: ${err instanceof Error ? err.message : err}`);
  }
}

// attempts to start service using custom command and wait up to 10s for signs of life
async function tryAutoStart(
  baseUrl: string,
  startCommand: string,
  log: LogFn,
): Promise<void> {
  if (!startCommand || !window.electronAPI?.spawnDetached) return;

  log("info", `Auto-starting service for ${baseUrl}: ${startCommand}`);
  const result = await window.electronAPI.spawnDetached(startCommand);
  if (!result.ok) {
    log("error", `Auto-start failed for ${baseUrl}: ${result.error}`);
    return;
  }
  log("info", `Auto-start launched (pid=${result.pid}), waiting for service at ${baseUrl}...`);

  // Poll health for up to 15s (30 × 500ms)
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 500));
    const models = await fetchModels(baseUrl);
    if (models) {
      log("info", `Service ${baseUrl} responded after ${((i + 1) * 0.5).toFixed(1)}s`);
      return;
    }
  }
  log("warn", `Service ${baseUrl} did not respond within 15s after auto-start`);
}

// ── Main entry point ───────────────────────────────────────────────────────────

interface ServiceInfo {
  kind: "transcription" | "llm";
  baseUrl: string;
  apiKey: string;
  model: string;
  startCommand: string;
}

export async function ensureCustomServices(log: LogFn): Promise<void> {
  const transcriptionProvider = localStorage.getItem("wisper_provider") || "groq";
  const llmProvider = localStorage.getItem("wisper_llm_provider") || "none";

  const services: ServiceInfo[] = [];

  if (transcriptionProvider === "custom") {
    const url = localStorage.getItem("wisper_custom_url") || "";
    if (url) {
      services.push({
        kind: "transcription",
        baseUrl: getBaseUrl(url),
        apiKey: localStorage.getItem("wisper_custom_key") || "",
        model: localStorage.getItem("wisper_custom_model") || "",
        startCommand: localStorage.getItem("wisper_custom_start_cmd") || "",
      });
    }
  }

  if (llmProvider === "custom") {
    const url = localStorage.getItem("wisper_llm_custom_url") || "";
    if (url) {
      services.push({
        kind: "llm",
        baseUrl: getBaseUrl(url),
        apiKey: localStorage.getItem("wisper_llm_custom_key") || "",
        model: localStorage.getItem("wisper_llm_model_custom") || "",
        startCommand: localStorage.getItem("wisper_llm_custom_start_cmd") || "",
      });
    }
  }

  if (services.length === 0) return;

  // ── Phase 1: Health check + auto-start (first recording only) ────────────────

  if (!healthCheckedThisSession) {
    healthCheckedThisSession = true;

    // Deduplicate by baseUrl (matching baseUrls mean the same provider; only need to check once)
    // — prefer the entry that has a start command
    const uniqueByUrl = new Map<string, ServiceInfo>();
    for (const s of services) {
      const existing = uniqueByUrl.get(s.baseUrl);
      if (!existing || (!existing.startCommand && s.startCommand)) {
        uniqueByUrl.set(s.baseUrl, s);
      }
    }

    // run health checks / startup commands concurrently on all service providers
    await Promise.allSettled(
      [...uniqueByUrl.entries()].map(async ([baseUrl, service]) => {
        const hcT0 = Date.now();
        const models = await fetchModels(baseUrl, service.apiKey);
        const hcMs = Date.now() - hcT0;
        if (models) {
          log("info", `Health check OK for ${baseUrl} (${models.data.length} model(s)) [${hcMs}ms]`);
          // Warn if any configured model for this URL isn't in the list
          const ids = models.data.map((m) => m.id);
          if (ids.length > 0) {
            for (const s of services) {
              if (s.baseUrl === baseUrl && s.model && !ids.includes(s.model)) {
                log(
                  "warn",
                  `Model '${s.model}' not found in models from ${baseUrl} ` +
                    `(available: ${ids.join(", ")}) — this will likely cause a downstream failure`,
                );
              }
            }
          }
        } else {
          log(service.startCommand ? "info" : "warn", `Health check failed for ${baseUrl} [${hcMs}ms]`);
          if (service.startCommand) {
            await tryAutoStart(baseUrl, service.startCommand, log);
            // be nice and give services another 0.1s to handle requests
            await new Promise<void>((r) => setTimeout(r, 100));
          }
        }
      }),
    );
  }

  // ── Phase 2: Warm-up (rate-limited per service kind) ─────────────────────────

  const now = Date.now();
  const warmupPromises: Promise<void>[] = [];

  for (const service of services) {
    if (!service.model) continue;

    const intervalKey =
      service.kind === "transcription"
        ? "wisper_warmup_interval_sec"
        : "wisper_llm_warmup_interval_sec";
    const intervalMs =
      parseInt(localStorage.getItem(intervalKey) || "300", 10) * 1000;

    const warmupKey = `${service.baseUrl}:${service.kind}`;
    const lastWarmup = lastWarmupTime.get(warmupKey) ?? 0;
    if (now - lastWarmup < intervalMs && lastWarmupModel.get(warmupKey) === service.model) continue;

    lastWarmupTime.set(warmupKey, now);
    lastWarmupModel.set(warmupKey, service.model);

    if (service.kind === "transcription") {
      warmupPromises.push(warmUpTranscription(service.baseUrl, service.apiKey, service.model, log));
    } else {
      warmupPromises.push(warmUpLLM(service.baseUrl, service.apiKey, service.model, log));
    }
  }

  // Fire warm-up in the background — caller has already been unblocked after Phase 1
  Promise.allSettled(warmupPromises);
}
