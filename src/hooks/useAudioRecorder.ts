import { useState, useRef, useCallback, useEffect } from "react";
import { SegmentAccumulator } from "../audio/SegmentAccumulator";
import { WhisperQueue } from "../audio/WhisperQueue";
import {
  getTranscriptionConfig,
  validateTranscriptionConfig,
  transcribeAudioBlob,
} from "../audio/transcriptionApi";
import { VAD_CONFIG } from "../audio/vadConfig";
import { getBaseUrl, invalidateServiceContact } from "../audio/customModelService";

interface UseAudioRecorderReturn {
  isRecording: boolean;
  audioLevel: number;
  transcriptionProgress: { completed: number; total: number } | null;
  fatalTranscriptionError: Error | null;
  startRecording: (readyPromise?: Promise<void>) => Promise<void>;
  stopRecording: (separator?: string) => Promise<string | null>;
  saveDebugBlob: (blob: Blob, filename: string) => Promise<void>;
  playErrorSound: () => void;
  releaseMic: () => void;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcriptionProgress, setTranscriptionProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [fatalTranscriptionError, setFatalTranscriptionError] = useState<Error | null>(null);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const isMonitoringRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Source name the current stream's "default" device resolved to when opened — lets the
  // keep-warm reuse check notice the user switched default microphones in the meantime
  const streamMicSourceRef = useRef("");

  // VAD pipeline refs. The MicVAD instance is created once (at mount — loading the ONNX
  // model needs no microphone) and reused across recordings via pause()/start(): on each
  // re-start MicVAD calls our resumeStream() and builds a fresh source node from whatever
  // stream it returns, which is the library's supported stream-swap path. Its frame
  // processor resets VAD state (incl. the Silero RNN) on pause(), so recordings stay
  // independent. destroy() only happens on unmount or when a broken instance is discarded.
  const vadRef = useRef<any>(null); // persistent MicVAD instance
  const vadInitPromiseRef = useRef<Promise<any> | null>(null); // in-flight MicVAD creation
  const vadActiveRef = useRef(false); // current recording is using the VAD path
  const segmentAccumulatorRef = useRef<SegmentAccumulator | null>(null);
  const whisperQueueRef = useRef<WhisperQueue | null>(null);
  // Per-recording gates read by the persistent onFrameProcessed callback
  const accumulateFramesRef = useRef(false); // don't accumulate audio until chime finishes
  const firstFrameResolveRef = useRef<(() => void) | null>(null);
  const discardFirstFrameRef = useRef(false); // drop the stale first frame after each start

  // MediaRecorder fallback refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");

  // Debug audio saving
  const debugSessionRef = useRef<string | null>(null);
  const debugSegmentTranscriptsRef = useRef<Map<number, { text: string; durationSec: number; latencyMs?: number }>>(new Map());

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
      // destroy() rejects if the VAD never started (no stream to look up) — nothing to
      // release in that case anyway
      vadRef.current?.destroy().catch(() => {});
      vadRef.current = null;
      // a kept-warm stream outlives recordings; stop it explicitly
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      audioContext.close();
    };
  }, []);

  const playErrorSound = useCallback((): void => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(43, now);
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.setValueAtTime(0.06, now + 0.10);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
    osc.start(now);
    osc.stop(now + 0.2);
  }, []);

  const playChime = useCallback((frequency: number): Promise<void> => {
    if (localStorage.getItem("unhush_chimes_enabled") === "false") return Promise.resolve();
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

  // Fully release the capture stream; the device goes idle and the OS may suspend it.
  const releaseMic = useCallback(() => {
    streamSourceRef.current?.disconnect();
    streamSourceRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  // End-of-recording stream handling. With "keep mic warm" enabled, hold the stream open
  // between recordings: an idle capture device gets suspended by the OS a few seconds after
  // release (USB mics then autosuspend, and waking one is a slow USB reset-resume — see the
  // "Recording start" timing log), so keeping it open makes the next start near-instant.
  // The cost is honest and visible: the OS mic-in-use indicator stays on while warm.
  const cleanupStream = useCallback(() => {
    if (localStorage.getItem("unhush_keep_mic_warm") === "true") {
      streamSourceRef.current?.disconnect();
      streamSourceRef.current = null;
      return;
    }
    releaseMic();
  }, [releaseMic]);

  const wlog = useCallback((level: "debug" | "info" | "warn" | "error", message: string) => {
    window.electronAPI?.log(level, message);
  }, []);

  // Create (or re-create after a failure) the persistent MicVAD instance. Loading the
  // ONNX runtime + Silero model costs a few hundred ms but needs no microphone, so it
  // runs at mount — off the hotkey-to-ready path entirely. The stream callbacks read
  // streamRef so each recording's freshly-opened stream is picked up on vad.start().
  const createVad = useCallback(async (): Promise<any | null> => {
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");

      // onnxruntime-web silently forces single-threaded WASM (no warning, no error) when
      // the page isn't cross-origin isolated — log the actual state so a threading
      // regression is visible in unhush.log instead of only showing up as "VAD feels slow".
      // const isolated = typeof self !== "undefined" && self.crossOriginIsolated;
      // wlog("debug", `VAD: crossOriginIsolated=${isolated} (threaded WASM ${isolated ? "available" : "disabled — falling back to single-threaded"})`);
      // current dev build is known to fall back to single-threaded, but performs well enough. This could be fixable for dev but is harder for prod, so leave as-is for now.

      return await MicVAD.new({
        model: "v5",
        baseAssetPath: "./vad/",
        onnxWASMBasePath: new URL("./vad/", window.location.href).href,
        audioContext: audioContextRef.current!,
        getStream: () => Promise.resolve(streamRef.current!),
        pauseStream: () => Promise.resolve(),   // we handle stream lifecycle ourselves
        resumeStream: () => Promise.resolve(streamRef.current!),
        startOnLoad: false,
        positiveSpeechThreshold: VAD_CONFIG.positiveSpeechThreshold,
        negativeSpeechThreshold: VAD_CONFIG.negativeSpeechThreshold,
        onFrameProcessed: (
          probabilities: { isSpeech: number },
          frame: Float32Array,
        ) => {
          if (discardFirstFrameRef.current) {
            // The worklet's resampler buffer survives pause()/start() (it has no flush
            // message), so the first frame after a restart can carry up to ~32ms of the
            // previous recording's tail — non-silent audio that would fool the silent-
            // frame gate below into declaring a still-waking mic ready. The stale
            // remainder is < 1 frame, so dropping exactly one frame removes it all.
            discardFirstFrameRef.current = false;
            return;
          }
          if (firstFrameResolveRef.current) {
            // Mic hardware sends silent frames during init — skip until real audio arrives
            let maxAbs = 0;
            for (let i = 0; i < frame.length; i++) {
              const abs = Math.abs(frame[i]);
              if (abs > maxAbs) maxAbs = abs;
            }
            if (maxAbs <= 0.0001) return; // discard silent frame from mic init
            firstFrameResolveRef.current();
            firstFrameResolveRef.current = null;
          }
          if (!accumulateFramesRef.current) return; // discard frames during chime
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      wlog("warn", `VAD: failed to load model: ${msg}`);
      return null;
    }
  }, [wlog]);

  // Preload at mount so even the first recording skips the model load.
  useEffect(() => {
    if (!vadInitPromiseRef.current) vadInitPromiseRef.current = createVad();
  }, [createVad]);

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

  const startRecording = useCallback(async (readyPromise?: Promise<void>) => {
    // check transcription Config and fail early for obvious errors
    const config = getTranscriptionConfig();
    const validationError = validateTranscriptionConfig(config);
    if (validationError) throw new Error(validationError.message);

    try {
      // Stage timings for the one-line startup summary logged below. getUserMedia is the
      // stage that wakes the capture device — on suspended USB mics that's a full USB
      // reset-resume, so it dominates and varies wildly; measure it first and separately.
      const t0 = Date.now();
      // A kept-warm stream from the previous recording skips the device open entirely
      let warm = !!(streamRef.current?.active &&
        streamRef.current.getAudioTracks().some((t) => t.readyState === "live"));
      if (warm) {
        // If the user switched default mics since this stream was opened, reopen it on
        // the new default. Modern WirePlumber re-routes a live default-targeting stream
        // server-side (verified empirically), making this a harmless one-time extra
        // reopen — but older PulseAudio stacks leave the stream pinned to the old device,
        // and the renderer cannot tell either way (no devicechange event fires on a
        // default switch, and Chromium/Linux exposes only a "Default" pseudo-device with
        // no concrete label or groupId). Asking the main process (pactl) and reopening on
        // mismatch is the only behavior that's provably correct on every stack.
        const currentDefault = (await window.electronAPI?.getDefaultMicSource?.()) ?? "";
        if (currentDefault && streamMicSourceRef.current &&
            currentDefault !== streamMicSourceRef.current) {
          wlog("info", `Default microphone changed (${streamMicSourceRef.current} -> ${currentDefault}) — reopening warm stream`);
          releaseMic();
          warm = false;
        }
      }
      const stream = warm
        ? streamRef.current!
        : await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              // noiseSuppression: false,  // Keep noise suppression (on by default)
              autoGainControl: false,
            },
          });
      const tMic = Date.now();
      streamRef.current = stream;
      if (!warm) {
        // Record what "default" resolved to, for the next warm-reuse check (fire and
        // forget — not needed before recording starts)
        void window.electronAPI?.getDefaultMicSource?.().then((name) => {
          streamMicSourceRef.current = name ?? "";
        });
      }

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
      const debugAudio = localStorage.getItem("unhush_debug_audio") === "true";
      if (debugAudio) {
        const now = new Date();
        // shift epoch by local offset so toISOString() prints local time digits (not UTC)
        const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
        debugSessionRef.current = localISO.replace(/[:.]/g, "-");
      } else {
        debugSessionRef.current = null;
      }

      // Get transcription config early so WhisperQueue is ready
      const config = getTranscriptionConfig();
      const whisperQueue = new WhisperQueue(config);
      if (readyPromise) whisperQueue.setReadyPromise(readyPromise);
      whisperQueue.onProgress = (completed, total) => {
        setTranscriptionProgress({ completed, total });
      };
      whisperQueue.onLog = wlog;
      whisperQueue.onFatalError = (err) => setFatalTranscriptionError(err);
      if (debugAudio) {
        debugSegmentTranscriptsRef.current = new Map();
        whisperQueue.onSegmentTranscribed = (idx, text, latencyMs) => {
          const existing = debugSegmentTranscriptsRef.current.get(idx);
          debugSegmentTranscriptsRef.current.set(idx, { text, durationSec: existing?.durationSec ?? 0, latencyMs });
        };
      }
      whisperQueueRef.current = whisperQueue;

      // Try VAD pipeline, reusing the preloaded MicVAD with our fresh stream
      let vadInitialized = false;
      let tVadSetup = 0; // set when the VAD pipeline is up and waiting for its first frame
      try {
        // Await the mount-time preload; if it failed (or a previous recording discarded a
        // broken instance), rebuild once — same self-healing as the old create-per-start,
        // minus the cost on the happy path.
        if (!vadInitPromiseRef.current) vadInitPromiseRef.current = createVad();
        let vad = await vadInitPromiseRef.current;
        if (!vad) {
          vadInitPromiseRef.current = createVad();
          vad = await vadInitPromiseRef.current;
        }
        if (!vad) throw new Error("VAD model failed to load");
        vadRef.current = vad;

        const accumulator = new SegmentAccumulator((wavBlob, segmentIndex, durationSec) => {
          whisperQueueRef.current?.enqueue(wavBlob, segmentIndex);
          if (debugSessionRef.current) {
            debugSegmentTranscriptsRef.current.set(segmentIndex, { text: "", durationSec });
            const segmentName = `segment-${String(segmentIndex).padStart(3, "0")}.wav`;
            saveDebugBlob(wavBlob, segmentName);
          }
        });
        if (debugAudio) accumulator.enableDebug();
        accumulator.onLog = wlog;
        segmentAccumulatorRef.current = accumulator;

        accumulateFramesRef.current = false;
        discardFirstFrameRef.current = true;
        const firstFrameReady = new Promise<void>((resolve) => {
          firstFrameResolveRef.current = resolve;
        });

        // If a previous start failed partway and left the instance listening, pause first —
        // start() early-returns while listening and would silently keep the stale stream.
        if (vad.listening) await vad.pause();
        await vad.start(); // picks up our stream via getStream/resumeStream
        if (!vad.listening) {
          // start() swallows some failures into an internal errored state instead of throwing
          throw new Error(`VAD failed to start${vad.errored ? `: ${vad.errored}` : ""}`);
        }
        tVadSetup = Date.now();
        vadActiveRef.current = true;
        vadInitialized = true;

        // Wait for first real audio frame to confirm mic is active (2s timeout fallback)
        const timedOut = await Promise.race([
          firstFrameReady.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
        ]);
        if (timedOut) {
          wlog("warn", `VAD: timed out waiting for first frame after ${Date.now() - t0}ms`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        wlog("warn", `VAD initialization failed, falling back to MediaRecorder: ${msg}`);
        console.warn("VAD initialization failed, falling back to MediaRecorder:", err);
        vadActiveRef.current = false;
        firstFrameResolveRef.current = null;
        // Discard the possibly-broken instance; the next recording rebuilds from scratch
        vadRef.current?.destroy().catch(() => {});
        vadRef.current = null;
        vadInitPromiseRef.current = null;
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

      const tReady = Date.now();
      const micStage = `mic=${tMic - t0}ms${warm ? " (warm)" : ""}`;
      const stages = vadInitialized
        ? `${micStage}, vadSetup=${tVadSetup - tMic}ms, firstFrame=${tReady - tVadSetup}ms`
        : `${micStage}, recorderFallback=${tReady - tMic}ms`;
      // streamMicSourceRef is filled by a fire-and-forget IPC after each cold open; by now
      // it has virtually always resolved. Answers "which mic did this actually record from?"
      // — the renderer can't tell (track labels are just "Default"), but pactl can.
      const src = streamMicSourceRef.current;
      wlog("debug", `Recording start: ${stages}, total=${tReady - t0}ms${src ? `, source=${src}` : ""}`);

      const chimePromise = playChime(880);
      setIsRecording(true);  // turn red as chime plays

      await chimePromise;    // wait for chime to finish rendering

      // The chime only becomes audible after the output buffer drains (outputLatency), and
      // its speaker→mic pickup then rides back through the capture pipeline (track latency
      // + 32ms worklet framing), so frames carrying chime audio arrive well after onended.
      // Wait out that round trip before keeping audio, or the beep lands at the start of
      // segment 0 and the transcriber tries to interpret it. Clamped so a bogus latency
      // report can't visibly delay real speech capture.
      if (localStorage.getItem("unhush_chimes_enabled") !== "false") {
        const outMs = (audioContext.outputLatency || audioContext.baseLatency || 0) * 1000;
        // .latency is a Chromium extension to MediaTrackSettings, absent from TS's dom lib
        const capMs = ((stream.getAudioTracks()[0]?.getSettings() as { latency?: number })?.latency ?? 0) * 1000;
        const graceMs = Math.min(250, outMs + capMs + 64);
        await new Promise((resolve) => setTimeout(resolve, graceMs));
      }

      if (!vadInitialized) {
        // Keep header chunk for MediaRecorder fallback
        audioChunksRef.current = audioChunksRef.current.slice(0, 1);
      }
      accumulateFramesRef.current = true; // open gate: start accumulating audio

    } catch (err) {
      console.error("Failed to start recording:", err);
      throw err;
    }
  }, [playChime, startAudioLevelMonitoring, saveDebugBlob, wlog, createVad, releaseMic]);

  const stopRecording = useCallback(async (separator = " "): Promise<string | null> => {
    if (!isRecording) {
      return null;
    }

    playChime(660);
    stopAudioLevelMonitoring();
    setIsRecording(false);
    // Disable auto-stop callback — from here, rejectFinalize surfaces errors instead
    if (whisperQueueRef.current) whisperQueueRef.current.onFatalError = null;

    // config was validated at recording start
    const config = getTranscriptionConfig();

    try {
      let transcript: string;

      if (vadActiveRef.current && vadRef.current) {
        // VAD pipeline: pause VAD (keeping the instance and its loaded model for the next
        // recording — pause() also resets its speech state), flush remaining segments,
        // finalize queue
        await vadRef.current.pause();
        vadActiveRef.current = false;
        accumulateFramesRef.current = false;

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
        transcript = await queue.finalize(totalSegments, separator);

        if (debugSessionRef.current) {
          const lines: string[] = [];
          [...debugSegmentTranscriptsRef.current.entries()]
            .sort((a, b) => a[0] - b[0])
            .forEach(([idx, { text, durationSec, latencyMs }]) => {
              const timing = latencyMs !== undefined ? `${durationSec.toFixed(1)}s, ${latencyMs}ms latency` : `${durationSec.toFixed(1)}s`;
              lines.push(`=== Segment ${idx} (${timing}) ===\n${text}\n`);
            });
          lines.push(`=== Full concatenated ===\n${transcript}`);
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
      // A real transcription failure means the custom server is actually down — make sure
      // the next recording's health check re-probes it (and re-runs its Start Command)
      // right away instead of assuming it's still fine. Covers both the VAD/WhisperQueue
      // path and the MediaRecorder fallback path, since both throw into this catch.
      if (localStorage.getItem("unhush_provider") === "custom") {
        invalidateServiceContact(getBaseUrl(config.apiUrl));
      }
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
    fatalTranscriptionError,
    startRecording,
    stopRecording,
    saveDebugBlob,
    playErrorSound,
    releaseMic,
  };
}
