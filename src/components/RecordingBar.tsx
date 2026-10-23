import { useState, useEffect, useCallback, useRef } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { Waveform } from "./Waveform";
import { getLLMConfig, makeUserPrompt, postProcessTranscript, validateLLMConfig, SPLIT_POINT_MARKER, stripSplitMarkers } from "../audio/llmApi";
import { ensureCustomServices, customServerReachable, getLLMWarmupStatus, getTranscriptionWarmupStatus, pinOllamaKeepAlive, getBaseUrl, getRelevantConfigSnapshot } from "../audio/customModelService";
import { getTranscriptionConfig, validateTranscriptionConfig } from "../audio/transcriptionApi";
import { normalizePunctuation } from "../audio/textNormalization";

// Settles as `p` does, or rejects as soon as `signal` aborts: for awaits that can't
// themselves be cancelled, so a cancel isn't left waiting on them.
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });
}

function RecordingBar() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [slowLoadHint, setSlowLoadHint] = useState(false); // shown once transcribing runs long enough to look like a cold model load, not just normal processing
  const [cancelVisible, setCancelVisible] = useState(false); // the × that abandons a slow transcription
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<AbortController | null>(null); // aborts the transcription in progress
  const isStartingRef = useRef(false);   // true while startRecording() is in flight
  const deferredStopRef = useRef(false); // stop requested before startup finished
  const discardRef = useRef(false);      // the pending stop is a cancel: output and keep nothing
  // Mirrors isTranscribing for the start guard below. A ref, not the state value: a toggle
  // arriving microseconds after the stop that set it must see it, and state isn't readable
  // by an already-created callback until React has re-rendered.
  const isTranscribingRef = useRef(false);
  const llmFallbackStreak = useRef(0);   // consecutive "custom LLM warm-up not ready" fallbacks
  const lastRelevantConfigRef = useRef(""); // snapshot of provider-config fields as of the last check

  const {
    isRecording,
    audioLevel,
    fatalTranscriptionError,
    transcriptionRetrying,
    startRecording,
    stopRecording,
    saveDebugBlob,
    playErrorSound,
    playCancelSound,
    releaseMic,
  } = useAudioRecorder();

  useEffect(() => {
    if (fatalTranscriptionError && isRecording) handleStopRecording();
  }, [fatalTranscriptionError]);

  // One line per launch showing the renderer mounted and its IPC reaches main: the startup
  // marker scripts/smoke-test.sh waits for. Ref-guarded since StrictMode runs effects twice in dev.
  const mountLoggedRef = useRef(false);
  useEffect(() => {
    if (mountLoggedRef.current) return;
    mountLoggedRef.current = true;
    window.electronAPI?.log("info", "renderer mounted");
  }, []);

  // Once transcribing has run long enough that it's very unlikely to just be normal
  // processing, offer to cancel, and surface a "loading model" hint — the latter only when a
  // warm-up we actually know about is still pending, so this can't misfire as a generic "it's
  // just slow" message. A single check at the threshold is enough: cold loads run 10s-90s+, so
  // if one is in flight at 3s it'll still be in flight, and this only needs to flip on, not
  // track progress after that.
  useEffect(() => {
    if (!isTranscribing) {
      setSlowLoadHint(false);
      setCancelVisible(false);
      return;
    }
    const timer = setTimeout(() => {
      setCancelVisible(true);
      if (getTranscriptionWarmupStatus() === "pending" || getLLMWarmupStatus() === "pending") {
        setSlowLoadHint(true);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [isTranscribing]);

  // Known-bad settings (no API key, or no URL/model for a custom server) are static — no
  // need to wait for a live probe to fail before badging them. Unlike the runtime/warmup
  // reasons, this one is safe to both raise AND clear here, since "config" is its own
  // independent reason key and can't clobber an unrelated active warning.
  const checkConfigWarnings = useCallback(() => {
    const tError = validateTranscriptionConfig(getTranscriptionConfig());
    window.electronAPI?.setTranscriptionWarning("config", tError?.reasonKey === "config");
    window.electronAPI?.setTranscriptionWarning("badurl", tError?.reasonKey === "badurl");

    const llmConfig = getLLMConfig();
    const lError = llmConfig && validateLLMConfig(llmConfig);
    window.electronAPI?.setFormatterWarning("config", lError?.reasonKey === "config");
    window.electronAPI?.setFormatterWarning("badurl", lError?.reasonKey === "badurl");

    // Drives the first-run setup window's provider cards (referral only -- see
    // electron/providerSetup.cjs). Reuses the same validation just run above; never an API key.
    window.electronAPI?.setProviderStatus({
      transcription: {
        provider: (localStorage.getItem("unhush_provider") || "groq") as ProviderStatus["transcription"]["provider"],
        reason: tError?.reasonKey ?? null,
      },
      formatter: {
        provider: llmConfig?.provider ?? "none",
        reason: lError?.reasonKey ?? null,
      },
    });
  }, []);

  // Whenever Settings closes, it may have just fixed or broken a required field, or
  // pointed a custom provider at a URL that's well-formed but not actually responding —
  // recheck both the static config and live reachability right away rather than waiting
  // for the next recording attempt. (Live reachability is skipped at startup: it's already
  // probed lazily on the first recording, and ensureCustomServices() may spawn the
  // configured Start Command, which isn't something we want to do on every app launch.)
  // The live probe itself is skipped unless a field ensureCustomServices() actually cares
  // about changed — e.g. tweaking the system prompt or hotkey shouldn't trigger a network
  // round-trip (or worse, re-run a Start Command) on every Settings close.
  // force=true: the user just edited config, so probe now even if this exact baseUrl was
  // checked (and badged as broken) moments ago — otherwise a same-session fix wouldn't
  // clear the badge until the staleness window (up to an hour) lapsed.
  const recheckAfterSettingsClose = useCallback(() => {
    checkConfigWarnings();
    // If "keep mic warm" was just turned off, release the held stream now rather than
    // leaving the mic open (and its in-use indicator lit) until the next recording.
    // Skip while recording or starting — the stream is in active use then.
    if (localStorage.getItem("unhush_keep_mic_warm") !== "true" &&
        !isRecording && !isStartingRef.current) {
      releaseMic();
    }
    const snapshot = getRelevantConfigSnapshot();
    if (snapshot !== lastRelevantConfigRef.current) {
      lastRelevantConfigRef.current = snapshot;
      void ensureCustomServices((level, msg) => window.electronAPI?.log(level, msg), true);
    }
  }, [checkConfigWarnings, isRecording, releaseMic]);

  useEffect(() => {
    checkConfigWarnings();
    lastRelevantConfigRef.current = getRelevantConfigSnapshot();
    window.electronAPI?.onRecheckConfig(recheckAfterSettingsClose);
    return () => window.electronAPI?.removeAllListeners("recheck-config");
  }, [checkConfigWarnings, recheckAfterSettingsClose]);

  // The bar's ×: abandons the transcription in progress. Requests are aborted, and anything
  // that can't be is no longer waited on, so handleStopRecording() finishes at once.
  // `what` is for the log: also used to discard a recording (see handleCancelRequest).
  const handleCancel = useCallback((what: "transcription" | "recording") => {
    const cancel = cancelRef.current;
    if (!cancel || cancel.signal.aborted) return;
    window.electronAPI?.log("info", `${what} cancelled by user`);
    cancel.abort();
    playCancelSound();
    setOverlayVisible(false);
    window.electronAPI?.hideWindow();
  }, [playCancelSound]);

  const handleStopRecording = useCallback(async () => {
    if (isStartingRef.current) {
      // Startup still in progress — defer; handleStartRecording will call us when ready
      deferredStopRef.current = true;
      return;
    }
    if (window.electronAPI) {
      window.electronAPI.setRecordingState(false);
    }

    isTranscribingRef.current = true;
    setIsTranscribing(true);

    // Splits the wait between the hotkey and the text appearing into its two halves, so a slow
    // dictation can be blamed on the transcription server or the formatting pass without turning
    // on debug_audio (which writes every audio segment to disk). The per-segment latencies that
    // does record are the finer measure; this is the wall clock, which on the chunked path is
    // not their sum, since segments transcribe while recording continues.
    const tStop = Date.now();
    let tTranscribed = 0;
    const cancel = new AbortController();
    cancelRef.current = cancel;
    const { signal } = cancel;
    if (discardRef.current) {
      // Cancelled while recording: aborted before stopRecording() starts, so nothing more is sent,
      // and unlike a cancel during processing, nothing is kept for "Copy last" either
      discardRef.current = false;
      handleCancel("recording");
    }
    let transcript: string | null = null; // kept for "Copy last" if formatting is cancelled

    try {
      const llmConfig = getLLMConfig();
      transcript = await stopRecording(llmConfig ? SPLIT_POINT_MARKER : undefined, signal);
      tTranscribed = Date.now();
      window.electronAPI?.setTranscriptionWarning("runtime", false);

      if (transcript && window.electronAPI) {
        let finalTranscript = stripSplitMarkers(transcript);  // fallback
        // Skip LLM phase if custom server warm-up hasn't completed yet — avoids a long cold-load hang.
        // "skipped" means the user turned warm-up off for this server, so call it directly.
        const llmWarmup = getLLMWarmupStatus();
        const llmNotReady = llmConfig?.provider === "custom" && llmWarmup !== "ready" && llmWarmup !== "skipped";
        if (llmConfig?.provider === "custom") {
          // Only warm-up-not-ready counts toward the streak — live call errors and
          // over-length rejections further down are surfaced via logs, not this warning.
          llmFallbackStreak.current = llmNotReady ? llmFallbackStreak.current + 1 : 0;
          window.electronAPI?.setFormatterWarning("warmup", llmFallbackStreak.current >= 2);
        } else if (llmFallbackStreak.current > 0) {
          // User switched off the custom LLM provider — clear any stale warning.
          llmFallbackStreak.current = 0;
          window.electronAPI?.setFormatterWarning("warmup", false);
        }
        if (llmNotReady) {
          // Reports the last known warm-up status, not necessarily a fresh attempt from
          // this recording — Phase 2 may have skipped re-trying if it isn't due yet.
          window.electronAPI?.log("info", `Custom LLM not ready, last warm-up status: ${getLLMWarmupStatus()} — using raw Whisper transcript`);
        }
        // Matters mainly with warm-up off, since a failed warm-up already sets llmNotReady: a
        // server the health check found down would otherwise be waited on until the request
        // times out. Free while the server is believed healthy.
        const llmUnreachable = !!finalTranscript && llmConfig?.provider === "custom" && !llmNotReady &&
          !(await abortable(customServerReachable("llm", (level, msg) => window.electronAPI?.log(level, msg)), signal));
        if (llmUnreachable) {
          window.electronAPI.log("warn", "Custom LLM server unreachable — using raw transcript");
        }
        if (finalTranscript && llmConfig && !llmNotReady && !llmUnreachable) {
          let llmStatus = "error";
          let llmLatencyMs: number | undefined;
          const llmResult = await postProcessTranscript(transcript, llmConfig, signal).catch((err) => {
            if (signal.aborted) return;
            console.error("LLM post-processing failed, using raw transcript:", err);
            window.electronAPI.log(
              "error",
              `LLM post-processing failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          const llmOutput = llmResult?.content;
          if (llmResult !== undefined) {
            llmLatencyMs = llmResult.latencyMs;
            if (llmOutput!.length > Math.max(transcript.length * llmConfig.lengthMultiplier, transcript.length + llmConfig.lengthFloor)) {
              // Print lengths only in main log to protect privacy.
              window.electronAPI.log("warn",
                `LLM output (${llmOutput!.length} chars) exceeds length limit vs input (${transcript.length} chars) — discarding${
                  localStorage.getItem("unhush_debug_audio") === "true" ? " (full text in llm-pass.json)" : ""}`);
              llmStatus = "rejected_over_length";
            } else {
              llmStatus = "ok";
              // The model is asked to drop the markers but may not (llm-pass.json keeps its raw output)
              finalTranscript = stripSplitMarkers(llmOutput!);
              // Extend the Ollama model unload timer beyond the server default (~5 min unless configured)
              void pinOllamaKeepAlive(
                getBaseUrl(llmConfig.apiUrl), llmConfig.apiKey, llmConfig.model,
                localStorage.getItem("unhush_llm_keep_alive") ?? "2h",
                (level, msg) => window.electronAPI?.log(level, msg),
              );
            }
          }
          signal.throwIfAborted(); // to the catch below, without saving a cancelled pass
          if (localStorage.getItem("unhush_debug_audio") === "true") {
            const payload = JSON.stringify(
              {
                model: llmConfig.model,
                ...(llmLatencyMs !== undefined ? { latency_ms: llmLatencyMs } : {}),
                system_prompt: llmConfig.systemPrompt,
                whisper_transcript: transcript,
                input: makeUserPrompt(transcript, llmConfig),
                output: llmOutput || "",
                status: llmStatus,
                ...(llmStatus !== "ok" ? { returned_transcript: finalTranscript } : {}),
              },
              null,
              2,
            );
            saveDebugBlob(
              new Blob([payload], { type: "application/json" }),
              "llm-pass.json",
            );
          }
        }
        signal.throwIfAborted();
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
        window.electronAPI.log("debug",
          `stop-recording: transcribe ${tTranscribed - tStop}ms, format ${Date.now() - tTranscribed}ms`);
        const outputMethod = (localStorage.getItem("unhush_output_method") || "paste") as OutputMethod;
        // Every transcript, formatted or not, so output never depends on whether the LLM ran
        window.electronAPI.outputText(normalizePunctuation(finalTranscript), outputMethod);
      } else if (window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
      }
    } catch (err) {
      if (signal.aborted) {
        // handleCancel() already hid the bar. Nothing is output, but a finished transcript is
        // still offered by the tray's "Copy last" rather than lost.
        if (transcript) window.electronAPI?.setLastTranscript(normalizePunctuation(stripSplitMarkers(transcript)));
        return;
      }
      console.error("Transcription failed:", err);
      playErrorSound();
      setError(err instanceof Error ? err.message : "Transcription failed");
      window.electronAPI?.setTranscriptionWarning("runtime", true);
      setTimeout(() => {
        if (window.electronAPI) {
          setOverlayVisible(false);
          window.electronAPI.hideWindow();
        }
      }, 4000);
    } finally {
      cancelRef.current = null;
      isTranscribingRef.current = false;
      setIsTranscribing(false);
    }
  }, [stopRecording, handleCancel]);

  const handleStartRecording = useCallback(async () => {
    // A toggle landing while the previous transcript is still being produced must not open a
    // second recording. It looked harmless -- the pill stays in its "working" phase, because
    // that's what isTranscribing renders -- but the mic really did reopen, the start chime
    // really did sound, and the stop path then hid the window on top of a live recording that
    // nothing was left to stop. There is nothing to start into here (the transcript isn't out
    // yet), so decline, and undo the main process's optimistic isRecording flip: toggleRecording()
    // set it before sending, and without this the tray would sit in its recording state and the
    // ducked audio stay ducked until the next toggle.
    if (isTranscribingRef.current) {
      window.electronAPI?.setRecordingState(false);
      window.electronAPI?.log("info", "start-recording ignored: still transcribing the previous recording");
      return;
    }
    if (isStartingRef.current) {
      // A start while a start is still in flight: a stop-then-start pair pressed faster than the
      // mic could open. The in-flight startRecording() will deliver the recording the user ended
      // up asking for, so cancel the stop it deferred rather than opening a second one on top.
      deferredStopRef.current = false;
      discardRef.current = false;
      return;
    }
    deferredStopRef.current = false;
    discardRef.current = false;
    isStartingRef.current = true;
    try {
      setError(null);
      checkConfigWarnings();

      const log = (level: "info" | "warn" | "error", msg: string) => window.electronAPI?.log(level, msg);
      const readyPromise = ensureCustomServices(log);
      await startRecording(readyPromise, () => customServerReachable("transcription", log));
      isStartingRef.current = false; // must be before handleStopRecording guard check
      if (deferredStopRef.current) {
        // Stop was requested while we were starting up — honour it now
        handleStopRecording();
        return;
      }
      if (window.electronAPI) {
        window.electronAPI.setRecordingState(true);
      }
    } catch (err) {
      playErrorSound();
      setError(err instanceof Error ? err.message : "Failed to access microphone");
      setTimeout(() => {
        if (window.electronAPI) {
          setOverlayVisible(false);
          window.electronAPI.hideWindow();
        }
      }, 3500);
    } finally {
      isStartingRef.current = false;
    }
  }, [startRecording, playErrorSound, handleStopRecording, checkConfigWarnings]);

  // A cancel from outside the bar (the command fifo's "cancel"). Once recording has stopped it is
  // the ×. Before that, the recording is discarded: transcription requests in flight are aborted,
  // the audio not yet sent never is, and no text is output or kept.
  const handleCancelRequest = useCallback(() => {
    if (isTranscribingRef.current) {
      handleCancel("transcription");
    } else if (isStartingRef.current) {
      // handleStartRecording() runs the deferred stop as soon as the mic is open
      discardRef.current = true;
      deferredStopRef.current = true;
    } else if (isRecording) {
      discardRef.current = true;
      handleStopRecording();
    } else {
      window.electronAPI?.log("info", "cancel: no recording or transcription in progress, ignoring");
    }
  }, [isRecording, handleCancel, handleStopRecording]);

  // Listen for Electron events
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onStartRecording(() => {
        setOverlayVisible(true);
        handleStartRecording();
      });

      window.electronAPI.onStopRecording(() => {
        handleStopRecording();
      });

      window.electronAPI.onCancelRecording(handleCancelRequest);

      return () => {
        window.electronAPI.removeAllListeners("start-recording");
        window.electronAPI.removeAllListeners("stop-recording");
        window.electronAPI.removeAllListeners("cancel-recording");
      };
    }
  }, [handleStartRecording, handleStopRecording, handleCancelRequest]);

  // One-shot startup handoff to the main process. Deliberately kept out of the effect above, whose
  // dependencies chain back to isRecording (handleStartRecording -> startRecording), so it re-ran
  // on every recording start and stop. Re-registering the global shortcut mid-session is what
  // broke the second press of a toggle on Wayland, where Chromium responds to a changed command
  // set by tearing down and recreating its portal D-Bus session.
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.updateShortcut(
      localStorage.getItem("unhush_shortcut") || "Ctrl+Alt+Space"
    );
    window.electronAPI.setDuckingConfig({
      amount: parseInt(localStorage.getItem("unhush_ducking_amount") ?? "40", 10),
    });
    // The main process can't read localStorage, and its first-run setup check needs to know
    // whether the ydotool paste path is even in use before it decides whether to nag about it.
    window.electronAPI.setOutputMethod(
      (localStorage.getItem("unhush_output_method") as OutputMethod) || "paste"
    );
  }, []);

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-400 animate-pulse-ring" />
          <span className="text-red-300 text-sm font-medium whitespace-pre-wrap">{error}</span>
        </div>
      );
    }

    if (isTranscribing) {
      const metalPill = { background: "linear-gradient(to bottom, #1a3dbe, #a0b4ff 50%, #1a3dbe)" };
      return (
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-1.5 h-8">
              <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite]" style={{ ...metalPill, height: '40%' }} />
              <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.1s]" style={{ ...metalPill, height: '80%' }} />
              <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.2s]" style={{ ...metalPill, height: '60%' }} />
              <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.3s]" style={{ ...metalPill, height: '100%' }} />
              <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.4s]" style={{ ...metalPill, height: '50%' }} />
            </div>
            {transcriptionRetrying ? (
              <span className="text-white/60 text-[13px] whitespace-nowrap">
                Transcription timed out — retrying
              </span>
            ) : slowLoadHint && (
              <span className="text-white/60 text-[13px] whitespace-nowrap">
                Loading model after being idle — this can take a bit
              </span>
            )}
          </div>
          {cancelVisible && (
            <button
              type="button"
              onClick={() => handleCancel("transcription")}
              title="Cancel"
              aria-label="Cancel transcription"
              className="w-6 h-6 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/15 text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>
      );
    }

    if (isRecording) {
      return <Waveform audioLevel={audioLevel} isRecording={isRecording} />;
    }

    return <Waveform audioLevel={0} isRecording={false} />;
  };

  return (
    <div className="w-full h-full flex items-center justify-center">
      {overlayVisible && (
        <div
          className="flex items-center justify-center px-6 h-20 min-w-[198px] rounded-full ring-1 ring-white/10 shadow-xl"
          style={{ background: "rgba(14, 14, 22, 0.60)" }}
        >
          {renderContent()}
        </div>
      )}
    </div>
  );
}

export default RecordingBar;
