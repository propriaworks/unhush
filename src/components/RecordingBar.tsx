import { useState, useEffect, useCallback } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { Waveform } from "./Waveform";

const DEBUG_AUDIO = false;

function RecordingBar() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { isRecording, audioLevel, startRecording, stopRecording } =
    useAudioRecorder();

  const transcribeAudio = async (audioBlob: Blob) => {
    const provider = localStorage.getItem("wisper_provider") || "groq";

    let apiKey: string;
    let apiUrl: string;
    let model: string;

    if (provider === "groq") {
      apiKey = localStorage.getItem("wisper_groq_key") || "";
      apiUrl = "https://api.groq.com/openai/v1/audio/transcriptions";
      model = "whisper-large-v3-turbo";
    } else if (provider === "openai") {
      apiKey = localStorage.getItem("wisper_openai_key") || "";
      apiUrl = "https://api.openai.com/v1/audio/transcriptions";
      model = "whisper-1";
    } else {
      apiKey = localStorage.getItem("wisper_custom_key") || "";
      apiUrl = localStorage.getItem("wisper_custom_url") || "";
      model = localStorage.getItem("wisper_custom_model") || "";
    }

    let errMsg = ""
    if (provider === "custom" && !(apiUrl && model)) {
      errMsg = "API URL or model is unset. Open Settings from tray.";
    } else if (provider !== "custom" && !apiKey) {
      // apiKey is not required for custom
      errMsg = "No API key. Open Settings from tray.";
    }
    if (errMsg) {
      setError(errMsg);
      setTimeout(() => {
        if (window.electronAPI) {
          setOverlayVisible(false);
          window.electronAPI.hideWindow();
        }
      }, 2000);
      return;
    }

    setIsTranscribing(true);

    try {
      const formData = new FormData();
      const extension = audioBlob.type.includes("ogg") ? "ogg" : "webm";
      formData.append("file", audioBlob, `recording.${extension}`);
      formData.append("response_format", "text");

      formData.append("model", model);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (provider === "custom" && response.status == 405)
          throw new Error("API error 405. Did you include the full v1/audio/transcriptions endpoint URL?")
        else
          throw new Error(
            errorData.error?.message || `API error ${response.status}: ${response.statusText}`,
          );
      }

      const text = await response.text();
      const trimmedText = text.trim();

      if (trimmedText && window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
        window.electronAPI.pasteToCursor(trimmedText);
      } else if (window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
      }
    } catch (err) {
      console.error("Transcription failed:", err);
      setError(err instanceof Error ? err.message : "Transcription failed");
      setTimeout(() => {
        if (window.electronAPI) {
          setOverlayVisible(false);
          window.electronAPI.hideWindow();
        }
      }, 2000);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleStartRecording = useCallback(async () => {
    try {
      setError(null);
      await startRecording();
      if (window.electronAPI) {
        window.electronAPI.setRecordingState(true);
      }
    } catch (err) {
      setError("Failed to access microphone");
    }
  }, [startRecording]);

  const handleStopRecording = useCallback(async () => {
    const audioBlob = await stopRecording();
    if (window.electronAPI) {
      window.electronAPI.setRecordingState(false);
    }
    if (audioBlob) {
      if (DEBUG_AUDIO && window.electronAPI?.saveDebugAudio) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const savedPath = await window.electronAPI.saveDebugAudio(arrayBuffer, audioBlob.type);
        if (savedPath) console.log("Debug audio saved to:", savedPath);
      }
      await transcribeAudio(audioBlob);
    } else if (window.electronAPI) {
      setOverlayVisible(false);
      window.electronAPI.hideWindow();
    }
  }, [stopRecording]);

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

      const savedShortcut = localStorage.getItem("wisper_shortcut") || "Shift+Space";
      window.electronAPI.updateShortcut(savedShortcut);

      return () => {
        window.electronAPI.removeAllListeners("start-recording");
        window.electronAPI.removeAllListeners("stop-recording");
      };
    }
  }, [handleStartRecording, handleStopRecording]);

  const renderContent = () => {
    if (!overlayVisible) return null;

    if (error) {
      return (
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <span className="text-red-300 text-sm font-medium">{error}</span>
        </div>
      );
    }

    if (isTranscribing) {
      return (
        <div className="flex items-center gap-1.5 h-6">
          <span className="w-1.5 bg-primary-500 rounded-full animate-[bounce_0.6s_infinite]" style={{ height: '40%' }} />
          <span className="w-1.5 bg-primary-500 rounded-full animate-[bounce_0.6s_infinite_0.1s]" style={{ height: '80%' }} />
          <span className="w-1.5 bg-primary-500 rounded-full animate-[bounce_0.6s_infinite_0.2s]" style={{ height: '60%' }} />
          <span className="w-1.5 bg-primary-500 rounded-full animate-[bounce_0.6s_infinite_0.3s]" style={{ height: '100%' }} />
          <span className="w-1.5 bg-primary-500 rounded-full animate-[bounce_0.6s_infinite_0.4s]" style={{ height: '50%' }} />
        </div>
      );
    }

    if (isRecording) {
      return <Waveform audioLevel={audioLevel} isRecording={isRecording} />;
    }

    return <Waveform audioLevel={0} isRecording={false} />;
  };

  return (
    <div className="w-full h-full flex items-center justify-center px-4">
      {renderContent()}
    </div>
  );
}

export default RecordingBar;
