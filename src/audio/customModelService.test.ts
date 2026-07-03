import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file targets the gating/dedup logic in ensureCustomServices() specifically — the
// staleness-vs-failure-retry interval selection, the in-flight per-baseUrl lock, and Phase
// 2 skipping warm-up when Phase 1 already knows the service is down. That logic is stateful
// and timing-dependent, which is exactly the kind of thing that's easy to get subtly wrong
// and hard to verify by hand (see TODO.md for a running list of what else is worth covering).

type FetchResult = { ok: boolean; status?: number; json?: () => Promise<unknown> };
type FetchRoute = (url: string, init?: RequestInit) => FetchResult;

function makeFetchMock(route: FetchRoute) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = route(url, init);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: r.json ?? (async () => ({})),
    };
  });
}

function setupCustomTranscription(opts: {
  url: string;
  model?: string;
  startCommand?: string;
  apiKey?: string;
}) {
  localStorage.setItem("unhush_provider", "custom");
  localStorage.setItem("unhush_custom_url", opts.url);
  localStorage.setItem("unhush_custom_model", opts.model ?? "");
  localStorage.setItem("unhush_custom_start_cmd", opts.startCommand ?? "");
  localStorage.setItem("unhush_custom_key", opts.apiKey ?? "");
}

const noopLog = () => {};

let mod: typeof import("./customModelService");

beforeEach(async () => {
  vi.resetModules(); // fresh module instance per test — clears its module-scope Maps
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  localStorage.clear();
  // A complete-but-inert stub — every method ensureCustomServices() might call, always
  // present. `window.electronAPI?.foo()` only guards `electronAPI` itself being missing, not
  // an individual method being missing — a partial mock (e.g. `{ spawnDetached }` alone)
  // throws on the first call to whatever method wasn't included, since that's a genuine
  // TypeError, not something the `?.` protects against.
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    log: vi.fn(),
    setTranscriptionWarning: vi.fn(),
    setFormatterWarning: vi.fn(),
  };
  mod = await import("./customModelService");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ensureCustomServices — Phase 1 staleness gating", () => {
  it("does not re-probe a baseUrl checked moments ago", async () => {
    setupCustomTranscription({ url: "http://localhost:9001", model: "test-model" });
    const fetchMock = makeFetchMock(() => ({ ok: true, json: async () => ({ object: "list", data: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await mod.ensureCustomServices(noopLog);
    const modelsCallsAfterFirst = fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;
    expect(modelsCallsAfterFirst).toBeGreaterThan(0);

    await mod.ensureCustomServices(noopLog); // immediately again, force=false
    const modelsCallsAfterSecond = fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;
    expect(modelsCallsAfterSecond).toBe(modelsCallsAfterFirst);
  });

  it("retries a failed health check after HEALTHCHECK_FAILURE_RETRY_MS, not the full staleness window", async () => {
    setupCustomTranscription({ url: "http://localhost:9002", model: "test-model" }); // no Start Command
    const fetchMock = makeFetchMock(() => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    const modelsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;

    await mod.ensureCustomServices(noopLog);
    const after1 = modelsCalls();
    expect(after1).toBeGreaterThan(0);

    // Just under the failure-retry cooldown — should still be considered "recently checked"
    vi.setSystemTime(Date.now() + mod.HEALTHCHECK_FAILURE_RETRY_MS - 1000);
    await mod.ensureCustomServices(noopLog);
    expect(modelsCalls()).toBe(after1);

    // Past the failure-retry cooldown, but nowhere near the full staleness window — due again
    vi.setSystemTime(Date.now() + 2000);
    await mod.ensureCustomServices(noopLog);
    expect(modelsCalls()).toBeGreaterThan(after1);
  });

  it("re-probes a successfully-checked baseUrl once the full staleness window elapses", async () => {
    // No model — keeps Phase 2 (which also refreshes lastServiceContact on success) out of
    // the way, so this isolates Phase 1's own staleness timer.
    setupCustomTranscription({ url: "http://localhost:9012" });
    const fetchMock = makeFetchMock(() => ({ ok: true, json: async () => ({ object: "list", data: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const modelsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;

    await mod.ensureCustomServices(noopLog);
    const after1 = modelsCalls();
    expect(after1).toBeGreaterThan(0);

    // Just under the default staleness window (unhush_provider_restart_stale_min, default 60
    // min) — a successful check should still be considered fresh this whole time.
    const staleMs = mod.DEFAULT_PROVIDER_RESTART_STALE_MIN * 60_000;
    vi.setSystemTime(Date.now() + staleMs - 1000);
    await mod.ensureCustomServices(noopLog);
    expect(modelsCalls()).toBe(after1);

    // Past the staleness window — due again, even though the last check succeeded.
    vi.setSystemTime(Date.now() + 2000);
    await mod.ensureCustomServices(noopLog);
    expect(modelsCalls()).toBeGreaterThan(after1);
  });

  it("measures the failure-retry cooldown from when the attempt finished, not when it started", async () => {
    setupCustomTranscription({
      url: "http://localhost:9013",
      model: "test-model",
      startCommand: "fake-start-command",
    });
    const fetchMock = makeFetchMock(() => ({ ok: false })); // server never responds, ever
    vi.stubGlobal("fetch", fetchMock);
    const spawnDetached = vi.fn(async () => ({ ok: true, pid: 1 }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.spawnDetached = spawnDetached;
    const modelsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;

    // Every due Phase-1 attempt here re-triggers a full ~15s auto-start poll (the health
    // check always fails and a Start Command is configured), so every call needs fake time
    // advanced past that — harmless on calls where nothing was actually due, since there's
    // nothing scheduled to advance through.
    const runAndSettle = async (force = false) => {
      const p = mod.ensureCustomServices(noopLog, force);
      await vi.advanceTimersByTimeAsync(16_000); // 30 x 500ms poll + 100ms grace ≈ 15.1s
      await p;
    };

    const t0 = Date.now();
    await runAndSettle();
    const tComplete = Date.now();
    expect(tComplete - t0).toBeGreaterThan(15_000); // sanity: the attempt really did take ~15s
    const after1 = modelsCalls();

    // Past HEALTHCHECK_FAILURE_RETRY_MS since the attempt *started*, but still before that
    // interval has elapsed since it *finished* — only a "measured from start" bug would
    // consider this due.
    vi.setSystemTime(t0 + mod.HEALTHCHECK_FAILURE_RETRY_MS + 5_000);
    await runAndSettle();
    expect(modelsCalls()).toBe(after1);

    // Past HEALTHCHECK_FAILURE_RETRY_MS since it *finished* — due either way.
    vi.setSystemTime(tComplete + mod.HEALTHCHECK_FAILURE_RETRY_MS + 5_000);
    await runAndSettle();
    expect(modelsCalls()).toBeGreaterThan(after1);
  });

  it("force=true re-probes even when not due", async () => {
    setupCustomTranscription({ url: "http://localhost:9003", model: "test-model" });
    const fetchMock = makeFetchMock(() => ({ ok: true, json: async () => ({ object: "list", data: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const modelsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;

    await mod.ensureCustomServices(noopLog);
    const after1 = modelsCalls();

    await mod.ensureCustomServices(noopLog); // not due — no change expected
    expect(modelsCalls()).toBe(after1);

    await mod.ensureCustomServices(noopLog, true); // force=true
    expect(modelsCalls()).toBeGreaterThan(after1);
  });
});

describe("ensureCustomServices — Phase 1 in-flight dedup", () => {
  it("only runs the Start Command once across two overlapping calls for the same baseUrl", async () => {
    setupCustomTranscription({
      url: "http://localhost:9004",
      model: "test-model",
      startCommand: "fake-start-command",
    });

    let modelsCallCount = 0;
    const fetchMock = makeFetchMock(() => {
      modelsCallCount++;
      // The initial health check (call #1) fails; every call after that — i.e. the
      // auto-start poll — succeeds, so the poll loop exits on its first tick.
      return { ok: modelsCallCount > 1, json: async () => ({ object: "list", data: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const spawnDetached = vi.fn(async () => ({ ok: true, pid: 4242 }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.spawnDetached = spawnDetached;

    // Deliberately not awaited between calls — this is the race the in-flight lock guards
    // against (e.g. a rapid recording retry racing a Settings-close force=true).
    const p1 = mod.ensureCustomServices(noopLog);
    const p2 = mod.ensureCustomServices(noopLog);

    await vi.advanceTimersByTimeAsync(1000); // let the 500ms poll tick + 100ms grace elapse
    await Promise.all([p1, p2]);

    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });
});

describe("ensureCustomServices — Phase 2 warm-up gating", () => {
  it("skips warm-up when the last health check found the baseUrl unreachable", async () => {
    setupCustomTranscription({ url: "http://localhost:9005", model: "test-model" }); // no Start Command
    const fetchMock = makeFetchMock(() => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    await mod.ensureCustomServices(noopLog);
    await vi.advanceTimersByTimeAsync(0);

    const warmupCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.TRANSCRIPTIONS_PATH));
    expect(warmupCalls.length).toBe(0);
  });

  it("attempts warm-up when the health check succeeds", async () => {
    setupCustomTranscription({ url: "http://localhost:9006", model: "test-model" });
    const fetchMock = makeFetchMock((url) => {
      if (url.endsWith(mod.MODELS_PATH)) return { ok: true, json: async () => ({ object: "list", data: [] }) };
      if (url.endsWith(mod.TRANSCRIPTIONS_PATH)) return { ok: true };
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);

    await mod.ensureCustomServices(noopLog);
    await vi.advanceTimersByTimeAsync(0);

    const warmupCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.TRANSCRIPTIONS_PATH));
    expect(warmupCalls.length).toBeGreaterThan(0);
  });

  it("retries a warm-up-specific failure after WARMUP_FAILURE_RETRY_MS, not the full interval", async () => {
    // Health check always succeeds (so Phase 2 isn't skipped via the healthOk gate) but the
    // warm-up call itself keeps failing — a different failure mode than an unreachable server,
    // e.g. a bad model name or the server rejecting this specific request.
    setupCustomTranscription({ url: "http://localhost:9014", model: "test-model" });
    const fetchMock = makeFetchMock((url) => {
      if (url.endsWith(mod.MODELS_PATH)) return { ok: true, json: async () => ({ object: "list", data: [] }) };
      if (url.endsWith(mod.TRANSCRIPTIONS_PATH)) return { ok: false };
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);
    const warmupCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.TRANSCRIPTIONS_PATH)).length;

    await mod.ensureCustomServices(noopLog);
    const after1 = warmupCalls();
    expect(after1).toBeGreaterThan(0);

    // Just under WARMUP_FAILURE_RETRY_MS — not due yet. (Phase 1 itself stays well inside its
    // own staleness window throughout this test, so it can't be what's gating the retry here.)
    vi.setSystemTime(Date.now() + mod.WARMUP_FAILURE_RETRY_MS - 1000);
    await mod.ensureCustomServices(noopLog);
    expect(warmupCalls()).toBe(after1);

    // Past WARMUP_FAILURE_RETRY_MS, but nowhere near the full warm-up interval — due again.
    vi.setSystemTime(Date.now() + 2000);
    await mod.ensureCustomServices(noopLog);
    expect(warmupCalls()).toBeGreaterThan(after1);
  });

  it("resumes warm-up once a later health check finds the baseUrl reachable again", async () => {
    setupCustomTranscription({ url: "http://localhost:9015", model: "test-model" }); // no Start Command
    let healthy = false;
    const fetchMock = makeFetchMock((url) => {
      if (url.endsWith(mod.MODELS_PATH)) return { ok: healthy, json: async () => ({ object: "list", data: [] }) };
      if (url.endsWith(mod.TRANSCRIPTIONS_PATH)) return { ok: true };
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);
    const warmupCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.TRANSCRIPTIONS_PATH)).length;

    await mod.ensureCustomServices(noopLog); // health check fails → warm-up skipped
    expect(warmupCalls()).toBe(0);

    vi.setSystemTime(Date.now() + mod.HEALTHCHECK_FAILURE_RETRY_MS + 5_000); // past Phase 1's own retry cooldown
    healthy = true;
    await mod.ensureCustomServices(noopLog); // health check now succeeds → warm-up should resume
    await vi.advanceTimersByTimeAsync(0);
    expect(warmupCalls()).toBeGreaterThan(0);
  });

  it("a successful warm-up keeps refreshing lastServiceContact, so an actively-used service never looks stale", async () => {
    setupCustomTranscription({ url: "http://localhost:9016", model: "test-model" });
    const fetchMock = makeFetchMock((url) => {
      if (url.endsWith(mod.MODELS_PATH)) return { ok: true, json: async () => ({ object: "list", data: [] }) };
      if (url.endsWith(mod.TRANSCRIPTIONS_PATH)) return { ok: true };
      return { ok: false };
    });
    vi.stubGlobal("fetch", fetchMock);
    const modelsCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith(mod.MODELS_PATH)).length;

    await mod.ensureCustomServices(noopLog); // Phase 1 + Phase 2 both succeed
    const after1 = modelsCalls();
    expect(after1).toBeGreaterThan(0);

    // Simulate repeated "active use" every warm-up interval — well past the Phase-1 staleness
    // window in total — but each call's warm-up success should keep pushing lastServiceContact
    // forward, so Phase 1 should never come due.
    const intervalMs = mod.DEFAULT_WARMUP_INTERVAL_SEC * 1000;
    for (let i = 0; i < 20; i++) { // 20 x default 4-min interval ≈ 80 min > default 60-min staleness
      vi.setSystemTime(Date.now() + intervalMs + 1000);
      await mod.ensureCustomServices(noopLog);
    }
    expect(modelsCalls()).toBe(after1); // Phase 1 never re-triggered
  });
});
