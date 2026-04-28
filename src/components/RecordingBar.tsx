import { useState, useEffect, useCallback, useRef } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { Waveform } from "./Waveform";
import { getLLMConfig, makeUserPrompt, postProcessTranscript, SPLIT_POINT_MARKER } from "../audio/llmApi";
import { ensureCustomServices } from "../audio/customModelService";

function RecordingBar() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStartingRef = useRef(false);   // true while startRecording() is in flight
  const deferredStopRef = useRef(false); // stop requested before startup finished

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

      if (transcript && window.electronAPI) {
        let finalTranscript = transcript.split(SPLIT_POINT_MARKER).join(" ").trim();  // fallback
        if (finalTranscript && llmConfig && !transcript.startsWith("[Error")) {
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
            }
          }
          if (localStorage.getItem("wisper_debug_audio") === "true") {
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
        const outputMethod = (localStorage.getItem("wisper_output_method") || "paste") as OutputMethod;
        window.electronAPI.outputText(finalTranscript, outputMethod);
      } else if (window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
      }
    } catch (err) {
      console.error("Transcription failed:", err);
      playErrorSound();
      setError(err instanceof Error ? err.message : "Transcription failed");
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
  }, [startRecording, playErrorSound, handleStopRecording]);

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
        localStorage.getItem("wisper_shortcut") || "Ctrl+Alt+Space";
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
