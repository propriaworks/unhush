import { useState, useEffect, useCallback, useRef } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { Waveform } from "./Waveform";
import { getLLMConfig, makeUserPrompt, postProcessTranscript, validateLLMConfig, SPLIT_POINT_MARKER } from "../audio/llmApi";
import { ensureCustomServices, getLLMWarmupStatus, pinOllamaKeepAlive, getBaseUrl } from "../audio/customModelService";
import { getTranscriptionConfig, validateTranscriptionConfig } from "../audio/transcriptionApi";

function RecordingBar() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStartingRef = useRef(false);   // true while startRecording() is in flight
  const deferredStopRef = useRef(false); // stop requested before startup finished
  const llmFallbackStreak = useRef(0);   // consecutive "custom LLM warm-up not ready" fallbacks

  const {
    isRecording,
    audioLevel,
    fatalTranscriptionError,
    startRecording,
    stopRecording,
    saveDebugBlob,
    playErrorSound,
  } = useAudioRecorder();

  useEffect(() => {
    if (fatalTranscriptionError && isRecording) handleStopRecording();
  }, [fatalTranscriptionError]);

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
  }, []);

  // Whenever Settings closes, it may have just fixed or broken a required field, or
  // pointed a custom provider at a URL that's well-formed but not actually responding —
  // recheck both the static config and live reachability right away rather than waiting
  // for the next recording attempt. (Live reachability is skipped at startup: it's already
  // probed lazily on the first recording, and ensureCustomServices() may spawn the
  // configured Start Command, which isn't something we want to do on every app launch.)
  const recheckAfterSettingsClose = useCallback(() => {
    checkConfigWarnings();
    void ensureCustomServices((level, msg) => window.electronAPI?.log(level, msg));
  }, [checkConfigWarnings]);

  useEffect(() => {
    checkConfigWarnings();
    window.electronAPI?.onRecheckConfig(recheckAfterSettingsClose);
    return () => window.electronAPI?.removeAllListeners("recheck-config");
  }, [checkConfigWarnings, recheckAfterSettingsClose]);

  const handleStopRecording = useCallback(async () => {
    if (isStartingRef.current) {
      // Startup still in progress — defer; handleStartRecording will call us when ready
      deferredStopRef.current = true;
      return;
    }
    if (window.electronAPI) {
      window.electronAPI.setRecordingState(false);
    }

    setIsTranscribing(true);

    try {
      const llmConfig = getLLMConfig();
      const transcript = await stopRecording(llmConfig ? SPLIT_POINT_MARKER : undefined);
      window.electronAPI?.setTranscriptionWarning("runtime", false);

      if (transcript && window.electronAPI) {
        let finalTranscript = transcript.split(SPLIT_POINT_MARKER).join(" ").trim();  // fallback
        // Skip LLM phase if custom server warm-up hasn't completed yet — avoids a long cold-load hang
        const llmNotReady = llmConfig?.provider === "custom" && getLLMWarmupStatus() !== "ready";
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
        if (finalTranscript && llmConfig && !transcript.startsWith("[Error") && !llmNotReady) {
          let llmStatus = "error";
          let llmLatencyMs: number | undefined;
          const llmResult = await postProcessTranscript(transcript, llmConfig).catch((err) => {
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
              window.electronAPI.log("warn",
                `LLM output (${llmOutput!.length} chars) exceeds length limit vs input (${transcript.length} chars) — discarding. LLM output: ${llmOutput}`);
              llmStatus = "rejected_over_length";
            } else {
              llmStatus = "ok";
              finalTranscript = llmOutput!;
              // Re-pin the Ollama model unload timer; /v1 requests reset it to the server default (~5 min)
              void pinOllamaKeepAlive(
                getBaseUrl(llmConfig.apiUrl), llmConfig.apiKey, llmConfig.model,
                localStorage.getItem("unhush_llm_keep_alive") ?? "2h",
                (level, msg) => window.electronAPI?.log(level, msg),
              );
            }
          }
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
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
        const outputMethod = (localStorage.getItem("unhush_output_method") || "paste") as OutputMethod;
        window.electronAPI.outputText(finalTranscript, outputMethod);
      } else if (window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
      }
    } catch (err) {
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
      setIsTranscribing(false);
    }
  }, [stopRecording]);

  const handleStartRecording = useCallback(async () => {
    deferredStopRef.current = false;
    isStartingRef.current = true;
    try {
      setError(null);
      checkConfigWarnings();

      const readyPromise = ensureCustomServices((level, msg) => window.electronAPI?.log(level, msg));
      await startRecording(readyPromise);
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

      const savedShortcut =
        localStorage.getItem("unhush_shortcut") || "Ctrl+Alt+Space";
      window.electronAPI.updateShortcut(savedShortcut);

      return () => {
        window.electronAPI.removeAllListeners("start-recording");
        window.electronAPI.removeAllListeners("stop-recording");
      };
    }
  }, [handleStartRecording, handleStopRecording]);

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
        <div className="flex items-center gap-1.5 h-8">
          <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite]" style={{ ...metalPill, height: '40%' }} />
          <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.1s]" style={{ ...metalPill, height: '80%' }} />
          <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.2s]" style={{ ...metalPill, height: '60%' }} />
          <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.3s]" style={{ ...metalPill, height: '100%' }} />
          <span className="w-1.5 rounded-full animate-[bounce_0.6s_infinite_0.4s]" style={{ ...metalPill, height: '50%' }} />
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
