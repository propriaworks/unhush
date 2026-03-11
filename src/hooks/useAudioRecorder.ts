import { useState, useRef, useCallback, useEffect } from "react";
import { SegmentAccumulator } from "../audio/SegmentAccumulator";
import { WhisperQueue } from "../audio/WhisperQueue";
import {
  getTranscriptionConfig,
  validateTranscriptionConfig,
  transcribeAudioBlob,
} from "../audio/transcriptionApi";
import { VAD_CONFIG } from "../audio/vadConfig";

interface UseAudioRecorderReturn {
  isRecording: boolean;
  audioLevel: number;
  transcriptionProgress: { completed: number; total: number } | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcriptionProgress, setTranscriptionProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const isMonitoringRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // VAD pipeline refs
  const vadRef = useRef<any>(null); // MicVAD instance
  const segmentAccumulatorRef = useRef<SegmentAccumulator | null>(null);
  const whisperQueueRef = useRef<WhisperQueue | null>(null);

  // MediaRecorder fallback refs
  const vadAvailableRef = useRef(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");

  // Debug audio saving
  const debugSessionRef = useRef<string | null>(null);
  const debugSegmentTranscriptsRef = useRef<Map<number, { text: string; durationSec: number }>>(new Map());

  // Create AudioContext and AnalyserNode once on mount
  useEffect(() => {
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    // Cache MIME type for fallback MediaRecorder
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

  const playChime = useCallback((frequency: number): Promise<void> => {
    const ctx = audioContextRef.current;
    if (!ctx) return Promise.resolve();
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
    return new Promise<void>((resolve) => { osc.onended = () => resolve(); });
  }, []);

  const startAudioLevelMonitoring = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
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
  }, []);

  const stopAudioLevelMonitoring = useCallback(() => {
    isMonitoringRef.current = false;
    cancelAnimationFrame(animationFrameRef.current);
    setAudioLevel(0);
  }, []);

  const cleanupStream = useCallback(() => {
    streamSourceRef.current?.disconnect();
    streamSourceRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const wlog = useCallback((level: "info" | "warn" | "error", message: string) => {
    window.electronAPI?.log(level, message);
  }, []);

  const saveDebugBlob = useCallback(async (blob: Blob, filename: string) => {
    const session = debugSessionRef.current;
    if (!session || !window.electronAPI?.saveDebugAudio) return;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const savedPath = await window.electronAPI.saveDebugAudio(
        arrayBuffer, blob.type, session, filename,
      );
      if (savedPath) console.log("Debug audio saved:", savedPath);
    } catch (err) {
      console.warn("Failed to save debug audio:", err);
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          // noiseSuppression: false,  // Keep noise suppression (on by default)
          autoGainControl: false,
        },
      });
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

      // Check if debug audio saving is enabled
      const debugAudio = localStorage.getItem("wisper_debug_audio") === "true";
      if (debugAudio) {
        debugSessionRef.current = new Date().toISOString().replace(/[:.]/g, "-");
      } else {
        debugSessionRef.current = null;
      }

      // Get transcription config early so WhisperQueue is ready
      const config = getTranscriptionConfig();
      const whisperQueue = new WhisperQueue(config);
      whisperQueue.onProgress = (completed, total) => {
        setTranscriptionProgress({ completed, total });
      };
      whisperQueue.onLog = wlog;
      if (debugAudio) {
        debugSegmentTranscriptsRef.current = new Map();
        whisperQueue.onSegmentTranscribed = (idx, text) => {
          const existing = debugSegmentTranscriptsRef.current.get(idx);
          debugSegmentTranscriptsRef.current.set(idx, { text, durationSec: existing?.durationSec ?? 0 });
        };
      }
      whisperQueueRef.current = whisperQueue;

      // Try VAD pipeline using MicVAD with our existing stream and AudioContext
      let vadInitialized = false;
      let accumulateFrames = false; // gate: don't accumulate audio until chime finishes
      try {
        const t0 = Date.now();
        const { MicVAD } = await import("@ricky0123/vad-web");

        const accumulator = new SegmentAccumulator((wavBlob, segmentIndex, durationSec) => {
          whisperQueueRef.current?.enqueue(wavBlob, segmentIndex);
          if (debugSessionRef.current) {
            debugSegmentTranscriptsRef.current.set(segmentIndex, { text: "", durationSec });
            const segmentName = `segment-${String(segmentIndex).padStart(3, "0")}.wav`;
            saveDebugBlob(wavBlob, segmentName);
          }
        });
        if (debugAudio) accumulator.enableDebug();
        segmentAccumulatorRef.current = accumulator;

        let firstFrameResolve: (() => void) | null = null;
        const firstFrameReady = new Promise<void>((resolve) => {
          firstFrameResolve = resolve;
        });
        // wlog("info", `VAD: loading model (audioCtx state=${audioContext.state})`);
        const vad = await MicVAD.new({
          model: "v5",
          baseAssetPath: "./vad/",
          onnxWASMBasePath: new URL("./vad/", window.location.href).href,
          audioContext,
          getStream: () => Promise.resolve(stream),
          pauseStream: () => Promise.resolve(),   // we handle stream lifecycle ourselves
          resumeStream: () => Promise.resolve(stream),
          startOnLoad: false,
          positiveSpeechThreshold: VAD_CONFIG.positiveSpeechThreshold,
          negativeSpeechThreshold: VAD_CONFIG.negativeSpeechThreshold,
          onFrameProcessed: (
            probabilities: { isSpeech: number },
            frame: Float32Array,
          ) => {
            if (firstFrameResolve) {
              // Mic hardware sends silent frames during init — skip until real audio arrives
              let maxAbs = 0;
              for (let i = 0; i < frame.length; i++) {
                const abs = Math.abs(frame[i]);
                if (abs > maxAbs) maxAbs = abs;
              }
              if (maxAbs > 0.0001) {
                // wlog("info", `VAD: first non-silent frame at +${Date.now() - t0}ms (peak=${maxAbs.toFixed(6)})`);
                firstFrameResolve();
                firstFrameResolve = null;
              } else {
                return; // discard silent frame from mic init
              }
            }
            if (!accumulateFrames) return; // discard frames during chime
            segmentAccumulatorRef.current?.addFrame(
              probabilities.isSpeech,
              frame,
            );
          },
          onSpeechStart: () => {},
          onSpeechEnd: () => {},
          onVADMisfire: () => {},
          onSpeechRealStart: () => {},
        });

        // wlog("info", `VAD: model loaded at +${Date.now() - t0}ms, starting audio pipeline`);
        await vad.start();
        // wlog("info", `VAD: pipeline started at +${Date.now() - t0}ms (audioCtx state=${audioContext.state}), waiting for first frame`);
        vadRef.current = vad;
        vadAvailableRef.current = true;
        vadInitialized = true;

        // Wait for first real audio frame to confirm mic is active (2s timeout fallback)
        const timedOut = await Promise.race([
          firstFrameReady.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
        ]);
        if (timedOut) {
          wlog("warn", `VAD: timed out waiting for first frame after ${Date.now() - t0}ms`);
        }
        // else {
        //   wlog("info", `VAD: ready at +${Date.now() - t0}ms`);
        // }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        wlog("warn", `VAD initialization failed, falling back to MediaRecorder: ${msg}`);
        console.warn("VAD initialization failed, falling back to MediaRecorder:", err);
        vadAvailableRef.current = false;
      }

      // Fallback: use MediaRecorder if VAD failed
      if (!vadInitialized) {
        const mimeType = mimeTypeRef.current;
        const mediaRecorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        audioChunksRef.current = [];

      // Resolve when the first encoded chunk arrives — proves full pipeline readiness.
        const firstChunkReady = new Promise<void>((resolve) => {
          let resolved = false;
          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              audioChunksRef.current.push(event.data);
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }
          };
        });

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(100);

        // Wait for first encoded audio chunk to confirm pipeline readiness (2s timeout)
        await Promise.race([
          firstChunkReady,
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }

      startAudioLevelMonitoring();

      // wlog("info", `Recording: playing chime and setting isRecording(true) (audioCtx state=${audioContextRef.current?.state})`);
      const chimePromise = playChime(880);
      setIsRecording(true);  // turn red as chime plays

      await chimePromise;    // wait for chime to finish

      if (!vadInitialized) {
        // Keep header chunk for MediaRecorder fallback
        audioChunksRef.current = audioChunksRef.current.slice(0, 1);
      }
      accumulateFrames = true; // open gate: start accumulating audio

    } catch (err) {
      console.error("Failed to start recording:", err);
      throw err;
    }
  }, [playChime, startAudioLevelMonitoring, saveDebugBlob, wlog]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!isRecording) {
      return null;
    }

    playChime(660);
    stopAudioLevelMonitoring();
    setIsRecording(false);

    // Validate config before transcribing
    const config = getTranscriptionConfig();
    const validationError = validateTranscriptionConfig(config);
    if (validationError) {
      // Clean up recording resources
      if (vadRef.current) {
        await vadRef.current.pause();
        await vadRef.current.destroy();
        vadRef.current = null;
      }
      mediaRecorderRef.current = null;
      segmentAccumulatorRef.current?.reset();
      segmentAccumulatorRef.current = null;
      whisperQueueRef.current = null;
      cleanupStream();
      throw new Error(validationError);
    }

    try {
      let transcript: string;

      if (vadAvailableRef.current && vadRef.current) {
        // VAD pipeline: pause VAD, flush remaining segments, finalize queue
        await vadRef.current.pause();
        await vadRef.current.destroy();
        vadRef.current = null;

        const accumulator = segmentAccumulatorRef.current!;
        accumulator.flushRemaining();
        const totalSegments = accumulator.totalSegments;

        // Debug: save full recording WAV (all frames across all segments)
        const fullWav = accumulator.getFullRecordingWav();
        if (fullWav) saveDebugBlob(fullWav, "full-recording.wav");

        segmentAccumulatorRef.current = null;

        if (totalSegments === 0) {
          // No speech detected at all
          cleanupStream();
          whisperQueueRef.current = null;
          setTranscriptionProgress(null);
          return null;
        }

        const queue = whisperQueueRef.current!;
        setTranscriptionProgress({ completed: 0, total: totalSegments });
        transcript = await queue.finalize(totalSegments);

        if (debugSessionRef.current) {
          const lines: string[] = [];
          [...debugSegmentTranscriptsRef.current.entries()]
            .sort((a, b) => a[0] - b[0])
            .forEach(([idx, { text, durationSec }]) =>
              lines.push(`=== Segment ${idx} (${durationSec.toFixed(1)}s) ===\n${text}\n`));
          lines.push(`=== Final ===\n${transcript}`);
          saveDebugBlob(new Blob([lines.join("\n")], { type: "text/plain" }), "transcript.txt");
        }
      } else {
        // MediaRecorder fallback: get blob, transcribe directly
        const mediaRecorder = mediaRecorderRef.current;
        if (!mediaRecorder) {
          cleanupStream();
          return null;
        }

        const audioBlob = await new Promise<Blob>((resolve) => {
          mediaRecorder.onstop = () => {
            const actualMimeType = mediaRecorder.mimeType || "audio/webm";
            resolve(
              new Blob(audioChunksRef.current, { type: actualMimeType }),
            );
          };
          mediaRecorder.stop();
        });
        mediaRecorderRef.current = null;

        // Debug: save fallback recording blob
        const ext = audioBlob.type.includes("ogg") ? "ogg" : "webm";
        saveDebugBlob(audioBlob, `full-recording.${ext}`);

        setTranscriptionProgress({ completed: 0, total: 1 });
        transcript = await transcribeAudioBlob(audioBlob, config);
        setTranscriptionProgress({ completed: 1, total: 1 });

        if (debugSessionRef.current) {
          saveDebugBlob(new Blob([transcript], { type: "text/plain" }), "transcript.txt");
        }
      }

      cleanupStream();
      whisperQueueRef.current = null;
      setTranscriptionProgress(null);
      return transcript || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      wlog("error", `Transcription failed: ${msg}`);
      console.error("Transcription failed:", err);
      cleanupStream();
      whisperQueueRef.current = null;
      setTranscriptionProgress(null);
      throw err;
    }
  }, [isRecording, playChime, stopAudioLevelMonitoring, cleanupStream, saveDebugBlob, wlog]);

  return {
    isRecording,
    audioLevel,
    transcriptionProgress,
    startRecording,
    stopRecording,
  };
}
