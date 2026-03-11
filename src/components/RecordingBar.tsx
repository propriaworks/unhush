import { useState, useEffect, useCallback } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { Waveform } from "./Waveform";

function RecordingBar() {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    isRecording,
    audioLevel,
    transcriptionProgress,
    startRecording,
    stopRecording,
  } = useAudioRecorder();

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
    if (window.electronAPI) {
      window.electronAPI.setRecordingState(false);
    }

    setIsTranscribing(true);

    try {
      const transcript = await stopRecording();

      if (transcript && window.electronAPI) {
        setOverlayVisible(false);
        window.electronAPI.hideWindow();
        window.electronAPI.pasteToCursor(transcript);
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

      const savedShortcut =
        localStorage.getItem("wisper_shortcut") || "Shift+Space";
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
          <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <span className="text-red-300 text-sm font-medium">{error}</span>
        </div>
      );
    }

    if (isTranscribing) {
      return (
        <div className="flex items-center gap-1.5 h-8">
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
