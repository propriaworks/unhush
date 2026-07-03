// ── Types ──────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  language?: string[]; // Speaches-specific: list of supported language codes
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

export const PROVIDER_BASE_URLS: Record<"groq" | "openai", string> = {
  groq: "https://api.groq.com/openai",
  openai: "https://api.openai.com",
};

// ── Module-level state ─────────────────────────────────────────────────────────

// Tracks when we last checked on a service per baseUrl — either a Phase-1 health-check
// attempt (success or failure) or a successful Phase-2 warm-up. Used to decide whether a
// custom service looks "stale" and is worth re-probing / restarting. Counting failed
// attempts (not just successes) keeps a permanently-broken server from being re-probed on
// every single recording — it's retried at most once per staleness window, unless the
// start command changes in the meantime.
const lastServiceContact = new Map<string, number>();

// Tracks the start command we last acted on (ran, or confirmed unnecessary) per baseUrl,
// so an edit to the command in Settings is detected and re-run even if the service was
// contacted recently.
const lastStartCommand = new Map<string, string>();

// Keyed by "baseUrl:kind" (e.g. "http://localhost:8080:transcription")
const lastWarmupTime = new Map<string, number>();
const lastWarmupModel = new Map<string, string>();
const lastWarmupOk = new Map<string, boolean>();

// A failed warm-up is retried much sooner than the (minutes-long) steady-state interval —
// otherwise a server that comes back up quickly still gets stuck on raw-transcript fallback
// for the rest of that interval, since the same cooldown was blocking the retry that would
// have noticed it was back.
const WARMUP_FAILURE_RETRY_MS = 15_000;

// Model list cache keyed by base URL (origin)
const modelCache = new Map<string, { models: ModelInfo[]; fetchedAt: number }>();

// Ollama detection cache — probed once per baseUrl per session
const ollamaCache = new Map<string, boolean>();

// Tracks whether the most recent custom LLM warm-up succeeded
let llmWarmupStatus: "idle" | "pending" | "ready" | "failed" = "idle";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function getBaseUrl(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).origin;
  } catch {
    return endpointUrl;
  }
}

/** True if `url` parses as an absolute http/https URL (e.g. rejects blank, malformed,
 * or non-http(s) values like a bare hostname or a "file:" URL). */
export function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
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
): Promise<boolean> {
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
      return true;
    } else {
      log("warn", `Transcription warm-up returned ${response.status} for ${baseUrl} [${latencyMs}ms]`);
      return false;
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    log("warn", `Transcription warm-up failed for ${baseUrl} [${latencyMs}ms]: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function warmUpLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  log: LogFn,
): Promise<boolean> {
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
      signal: AbortSignal.timeout(90000),
    });
    const latencyMs = Date.now() - t0;
    if (response.ok) {
      log("info", `LLM warm-up succeeded for ${baseUrl} [${latencyMs}ms]`);
      return true;
    } else {
      log("warn", `LLM warm-up returned ${response.status} for ${baseUrl} [${latencyMs}ms]`);
      return false;
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    log("warn", `LLM warm-up failed for ${baseUrl} [${latencyMs}ms]: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Detects whether the server at baseUrl is Ollama by probing /api/version. Result is cached. */
async function isOllama(baseUrl: string): Promise<boolean> {
  if (ollamaCache.has(baseUrl)) return ollamaCache.get(baseUrl)!;
  try {
    const response = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const result = response.ok;
    ollamaCache.set(baseUrl, result);
    return result;
  } catch {
    ollamaCache.set(baseUrl, false);
    return false;
  }
}

/**
 * Refreshes the Ollama model-unload timer after a dictation.
 *
 * Ollama's /v1/chat/completions shim resets keep_alive to the server-level default
 * (~5 min if not overriden) on every real request. Calling this after each LLM
 * post-processing step sets a longer duration via the ollama-native /api/generate
 * endpoint (empty prompt = no generation, just a timer refresh). No-ops silently
 * for non-Ollama servers. Designed to be called fire-and-forget (void).
 */
export async function pinOllamaKeepAlive(
  baseUrl: string,
  apiKey: string,
  model: string,
  keepAlive: string,
  log: LogFn,
): Promise<void> {
  if (!keepAlive) return; // empty string disables keep-alive pinning
  if (!(await isOllama(baseUrl))) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "", keep_alive: keepAlive }),
      signal: AbortSignal.timeout(90000),
    });
    if (response.ok) {
      log("info", `Ollama keep_alive pinned to ${keepAlive} for ${baseUrl}`);
    } else {
      log("warn", `Ollama keep_alive pin returned ${response.status} for ${baseUrl}`);
    }
  } catch (err) {
    log("warn", `Ollama keep_alive pin failed for ${baseUrl}: ${err instanceof Error ? err.message : err}`);
  }
}

// attempts to start service using custom command and wait up to 15s for signs of life.
// Returns true if the service was confirmed alive afterwards.
async function tryAutoStart(
  baseUrl: string,
  startCommand: string,
  log: LogFn,
): Promise<boolean> {
  if (!startCommand || !window.electronAPI?.spawnDetached) return false;

  log("info", `Auto-starting service for ${baseUrl}: ${startCommand}`);
  const result = await window.electronAPI.spawnDetached(startCommand);
  if (!result.ok) {
    log("error", `Auto-start failed for ${baseUrl}: ${result.error}`);
    return false;
  }
  log("info", `Auto-start launched (pid=${result.pid}), waiting for service at ${baseUrl}...`);

  // Poll health for up to 15s (30 × 500ms)
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 500));
    const models = await fetchModels(baseUrl);
    if (models) {
      log("info", `Service ${baseUrl} responded after ${((i + 1) * 0.5).toFixed(1)}s`);
      return true;
    }
  }
  log("warn", `Service ${baseUrl} did not respond within 15s after auto-start`);
  return false;
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
  const transcriptionProvider = localStorage.getItem("unhush_provider") || "groq";
  const llmProvider = localStorage.getItem("unhush_llm_provider") || "none";

  const services: ServiceInfo[] = [];

  // A malformed URL is already surfaced via the "config" warning (validateTranscriptionConfig /
  // validateLLMConfig) — no need to also probe it here, which would just fail again for the
  // same reason and pointlessly raise a second ("unreachable") warning on top of it.
  if (transcriptionProvider === "custom") {
    const url = localStorage.getItem("unhush_custom_url") || "";
    if (url && isValidHttpUrl(url)) {
      services.push({
        kind: "transcription",
        baseUrl: getBaseUrl(url),
        apiKey: localStorage.getItem("unhush_custom_key") || "",
        model: localStorage.getItem("unhush_custom_model") || "",
        startCommand: localStorage.getItem("unhush_custom_start_cmd") || "",
      });
    }
  }

  if (llmProvider === "custom") {
    const url = localStorage.getItem("unhush_llm_custom_url") || "";
    if (url && isValidHttpUrl(url)) {
      services.push({
        kind: "llm",
        baseUrl: getBaseUrl(url),
        apiKey: localStorage.getItem("unhush_llm_custom_key") || "",
        model: localStorage.getItem("unhush_llm_model_custom") || "",
        startCommand: localStorage.getItem("unhush_llm_custom_start_cmd") || "",
      });
    }
  }

  if (services.length === 0) return;

  // ── Phase 1: Health check + auto-start (first time, stale, or command changed) ─

  {
    // Deduplicate by baseUrl (matching baseUrls mean the same provider; only need to check once)
    // — prefer the entry that has a start command
    const uniqueByUrl = new Map<string, ServiceInfo>();
    for (const s of services) {
      const existing = uniqueByUrl.get(s.baseUrl);
      if (!existing || (!existing.startCommand && s.startCommand)) {
        uniqueByUrl.set(s.baseUrl, s);
      }
    }

    // Badges the tray with a "server unreachable" reason, independent of the "config"
    // reason (which only reflects static settings, not whether the server responds).
    // Applied per service kind sharing this baseUrl — a single local server can serve
    // both transcription and LLM. Only touched for baseUrls we actually (re-)probe below;
    // baseUrls skipped as "still fresh" keep whatever warning state they already had.
    const setUnreachable = (baseUrl: string, unreachable: boolean) => {
      for (const s of services) {
        if (s.baseUrl !== baseUrl) continue;
        if (s.kind === "transcription") window.electronAPI?.setTranscriptionWarning("unreachable", unreachable);
        else window.electronAPI?.setFormatterWarning("unreachable", unreachable);
      }
    };

    const staleMs =
      parseInt(localStorage.getItem("unhush_provider_restart_stale_min") || "60", 10) * 60_000;
    const phase1Now = Date.now();

    // Only probe services worth probing: never checked (covers first-run-ever, since the
    // map starts empty), gone stale since we last checked on it, or the configured start
    // command changed since we last acted on it. Otherwise assume the service is still up
    // and skip the round-trip — this keeps rapid re-recordings cheap.
    const dueForCheck = [...uniqueByUrl.entries()].filter(([baseUrl, service]) => {
      const stale = phase1Now - (lastServiceContact.get(baseUrl) ?? 0) > staleMs;
      const cmdChanged = service.startCommand !== (lastStartCommand.get(baseUrl) ?? "");
      return stale || cmdChanged;
    });

    // run health checks / startup commands concurrently on all due service providers
    await Promise.allSettled(
      dueForCheck.map(async ([baseUrl, service]) => {
        const hcT0 = Date.now();
        const models = await fetchModels(baseUrl, service.apiKey);
        const hcMs = Date.now() - hcT0;
        if (models) {
          modelCache.set(baseUrl, { models: models.data, fetchedAt: Date.now() });
          log("info", `Health check OK for ${baseUrl} (${models.data.length} model(s)) [${hcMs}ms]`);
          lastServiceContact.set(baseUrl, Date.now());
          lastStartCommand.set(baseUrl, service.startCommand);
          setUnreachable(baseUrl, false);
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
          // Mark the command as acted-on regardless of outcome, so a repeatedly-failing
          // unchanged command doesn't get re-run on every single stale check.
          lastStartCommand.set(baseUrl, service.startCommand);
          let recovered = false;
          if (service.startCommand) {
            recovered = await tryAutoStart(baseUrl, service.startCommand, log);
            // be nice and give services another 0.1s to handle requests
            await new Promise<void>((r) => setTimeout(r, 100));
          }
          setUnreachable(baseUrl, !recovered);
          // Record the attempt even on failure (with or without a start command), so a
          // permanently-broken server is retried on a cooldown — once per staleness
          // window — instead of on every single recording, unless the command changes.
          lastServiceContact.set(baseUrl, Date.now());
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
        ? "unhush_warmup_interval_sec"
        : "unhush_llm_warmup_interval_sec";
    const intervalMs =
      parseInt(localStorage.getItem(intervalKey) || "240", 10) * 1000;

    const warmupKey = `${service.baseUrl}:${service.kind}`;
    const lastWarmup = lastWarmupTime.get(warmupKey) ?? 0;
    const lastOk = lastWarmupOk.get(warmupKey) ?? false;
    const effectiveIntervalMs = lastOk ? intervalMs : WARMUP_FAILURE_RETRY_MS;
    if (now - lastWarmup < effectiveIntervalMs && lastWarmupModel.get(warmupKey) === service.model) continue;

    lastWarmupTime.set(warmupKey, now);
    lastWarmupModel.set(warmupKey, service.model);

    if (service.kind === "transcription") {
      warmupPromises.push(
        warmUpTranscription(service.baseUrl, service.apiKey, service.model, log).then(
          // A successful warm-up counts as recent contact, so an actively-used service
          // never looks stale even though Phase 1 only re-probes it occasionally.
          (ok) => {
            lastWarmupOk.set(warmupKey, ok);
            if (ok) lastServiceContact.set(service.baseUrl, Date.now());
          },
        ),
      );
    } else {
      llmWarmupStatus = "pending";
      warmupPromises.push(
        warmUpLLM(service.baseUrl, service.apiKey, service.model, log).then((ok) => {
          llmWarmupStatus = ok ? "ready" : "failed";
          lastWarmupOk.set(warmupKey, ok);
          if (ok) lastServiceContact.set(service.baseUrl, Date.now());
        }),
      );
    }
  }

  // Fire warm-up in the background — caller has already been unblocked after Phase 1
  Promise.allSettled(warmupPromises);
}

// ── Service contact invalidation ───────────────────────────────────────────────

/**
 * Clears the recorded last-contact time for a custom service's baseUrl, so the next
 * ensureCustomServices() call treats it as never-checked (same as a fresh app start) —
 * Phase 1 will re-probe it immediately and, if that also fails, re-run its Start Command,
 * rather than waiting out the (up to 60 min) staleness window. Call this when a real
 * (non-warmup) request to the service fails outright, e.g. a transcription that
 * exhausted its retries — that's a much stronger "this is actually down" signal than
 * warm-up alone, and worth reacting to on the very next attempt.
 */
export function invalidateServiceContact(baseUrl: string): void {
  lastServiceContact.delete(baseUrl);
}

// ── LLM warmup status ──────────────────────────────────────────────────────────

/** Returns the status of the most recent custom LLM warm-up request. */
export function getLLMWarmupStatus(): "idle" | "pending" | "ready" | "failed" {
  return llmWarmupStatus;
}

// ── Model cache access ─────────────────────────────────────────────────────────

export function getCachedModels(baseUrl: string): ModelInfo[] | null {
  return modelCache.get(baseUrl)?.models ?? null;
}

/** Fetch /v1/models, update the cache, and return the list. Returns null on failure. */
export async function refreshModels(baseUrl: string, apiKey?: string): Promise<ModelInfo[] | null> {
  if (!baseUrl) return null;
  const result = await fetchModels(baseUrl, apiKey);
  if (!result) {
    window.electronAPI?.log("warn", `refreshModels: failed to fetch models from ${baseUrl}/v1/models`);
    return null;
  }
  modelCache.set(baseUrl, { models: result.data, fetchedAt: Date.now() });
  return result.data;
}

// ── Metadata hint formatters ───────────────────────────────────────────────────

/** Returns a human-readable language hint for transcription models, or null if unavailable. */
export function formatTranscriptionHint(m: ModelInfo): string | null {
  if (!m.language || m.language.length === 0) return null;
  if (m.language.length === 1) return `language: ${m.language[0]}`;
  return `${m.language.length} languages`;
}

/** Returns a coarse age string for LLM models based on the `created` unix timestamp, or null. */
export function formatLlmHint(m: ModelInfo, now = Date.now()): string | null {
  if (!m.created || m.created <= 0) return null;
  const ageMs = now - m.created * 1000;
  const days = ageMs / 86_400_000;
  if (days < 7) return "<1 wk old";
  const weeks = Math.round(days / 7);
  if (weeks <= 8) return `${weeks} wk old`;
  const months = Math.round(days / 30.44);
  if (months <= 24) return `${months} mo old`;
  const years = Math.round(days / 365.25);
  return `${years} yr old`;
}
