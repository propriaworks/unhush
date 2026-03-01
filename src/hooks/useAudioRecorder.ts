import { useState, useRef, useCallback, useEffect } from "react";

interface AudioRecorderState {
  isRecording: boolean;
  audioLevel: number;
}

interface UseAudioRecorderReturn extends AudioRecorderState {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const isMonitoringRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const resolveStopRef = useRef<((blob: Blob | null) => void) | null>(null);
  const mimeTypeRef = useRef<string>("");

  // Create AudioContext and AnalyserNode once on mount — no mic acquired, no OS recording indicator
  useEffect(() => {
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    // Cache MIME type detection once
    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "audio/ogg;codecs=opus";
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = "";
        }
      }
    }
    mimeTypeRef.current = mimeType;

    return () => {
      isMonitoringRef.current = false;
      audioContext.close();
    };
  }, []);

  const playChime = useCallback((frequency: number) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = frequency;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.start(now);
    osc.stop(now + 0.18);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = audioContextRef.current!;
      const analyser = analyserRef.current!;

      // AudioContext may be suspended; resume before playing chime or connecting source
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      // Connect stream to the persistent AnalyserNode
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      streamSourceRef.current = source;

      // Start MediaRecorder immediately — codec must be running before speech arrives.
      // Starting it here (before the warmup delay) gives the Opus encoder time to
      // fully initialize; any leading silence is harmless for Whisper.
      const mimeType = mimeTypeRef.current;
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const actualMimeType = mediaRecorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, {
          type: actualMimeType,
        });
        if (resolveStopRef.current) {
          resolveStopRef.current(audioBlob);
          resolveStopRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100);

      // Start monitoring audio level
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      isMonitoringRef.current = true;
      const updateLevel = () => {
        if (isMonitoringRef.current && analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setAudioLevel(avg / 255);
          animationFrameRef.current = requestAnimationFrame(updateLevel);
        }
      };
      updateLevel();

      // Wait until the mic is delivering real audio AND at least 300 ms have elapsed.
      // The 300 ms floor covers both hardware warmup and codec initialization time.
      // The analyser check (noise floor > 0) is a secondary gate; on its own it fires
      // too fast (first-frame noise), so the timer dominates on cold start.
      await Promise.all([
        new Promise<void>(resolve => setTimeout(resolve, 300)),
        new Promise<void>(resolve => {
          const warmupData = new Uint8Array(analyser.frequencyBinCount);
          const deadline = setTimeout(resolve, 500);
          const check = () => {
            analyser.getByteFrequencyData(warmupData);
            if (warmupData.some(v => v > 0)) {
              clearTimeout(deadline);
              resolve();
            } else {
              requestAnimationFrame(check);
            }
          };
          requestAnimationFrame(check);
        }),
      ]);

      playChime(880);       // signals "mic is live, speak now"
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      throw err;
    }
  }, [playChime]);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && isRecording) {
        resolveStopRef.current = resolve;

        playChime(660);

        isMonitoringRef.current = false;
        cancelAnimationFrame(animationFrameRef.current);
        setAudioLevel(0);

        // Disconnect stream source before stopping tracks
        streamSourceRef.current?.disconnect();
        streamSourceRef.current = null;

        mediaRecorderRef.current.stop();
        setIsRecording(false);

        // Stop mic tracks — releases the device and OS recording indicator
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        // AudioContext and AnalyserNode stay alive for next recording
      } else {
        resolve(null);
      }
    });
  }, [isRecording, playChime]);

  return {
    isRecording,
    audioLevel,
    startRecording,
    stopRecording,
  };
}
