# Unhush Speech to Text Pipeline

## Overview

```mermaid
flowchart LR
    START(["`**User speaks**`"]) --> MIC["`Microphone
    stream`"]

    MIC --> VAD{"`VAD
    available?`"}

    VAD -->|Yes| SEG["`Speech segmentation
    VAD splits audio at
    natural pauses`"]
    VAD -->|No - fallback| FB["`Single recording
    up to 30s`"]

    SEG --> WQ["`Whisper API
    up to 3 concurrent
    requests`"]
    FB --> WQ

    WQ --> FINAL["`Transcript
    assembled in order`"]
    FINAL --> LLMAPI["`LLM API fixes formatting,
    removes filler text
    (if enabled)`"] --> PASTE(["`**Output text**`"])

    style START fill:#14532d,stroke:#22c55e,color:#86efac
    style PASTE fill:#14532d,stroke:#22c55e,color:#86efac
    style WQ fill:#1a2744,stroke:#3b82f6,color:#93c5fd
    style LLMAPI fill:#3b1f5e,stroke:#a855f7,color:#e9d5ff
```

## Detailed Pipeline

```mermaid
flowchart TD
    START(["`**Recording starts**`"]) --> MIC
    MIC["`**getUserMedia**
    mic stream`"]

    MIC --> AN["`AnalyserNode
    waveform viz`"]
    MIC --> VADINIT{"`MicVAD ready?
    preloaded at app start,
    rebuilt once if it failed`"}

    AN --> WAVE["`RecordingBar
    Waveform display`"]

    VADINIT -->|Yes| VAD["`**MicVAD**
    Silero ONNX
    resamples to 16kHz`"]
    VAD --> FIRSTFRAME["`Wait: first non-silent frame
    ≤2s timeout
    → start chime / gate opens`"]
    FIRSTFRAME -->|"`every 32ms:
    VAD prob, audio frame
    → onFrameProcessed`"| CA["`**SegmentAccumulator**
    accumulates PCM
    frames + VAD scores`"]

    CA --> FLUSH{"Segment
    flush
    condition?"}
    FLUSH -->|"`Natural pause
    speech-to-silence
    segment >= 15s`"| GATE
    FLUSH -->|"`Hard cut >= 29.9s
    at lowest VAD score
    in last 15s`"| SPLIT["`Split at
    cut point`"]
    FLUSH -->|No,
    accumulate more| CA
    SPLIT --> GATE

    GATE{"`>= 6 speech frames?
    (~190ms)`"}
    GATE -->|"`No: misfire
    (cough, click)`"| DISCARD["`Discard segment`"]
    GATE -->|Yes| TRIM["`Trim silence
    leading: keep 1s pad
    trailing: keep ~290ms`"]
    TRIM --> ENCODE["`Encode WAV
    16-bit 16kHz mono`"]

    ENCODE -.-> DBG_CHUNK["`Debug: save
    segment-NNN.wav`"]:::debug
    ENCODE --> WQ

    subgraph WQ ["`**WhisperQueue**`"]
        direction LR
        SLOT1["API slot 1"]
        SLOT2["API slot 2"]
        SLOT3["API slot 3"]
    end

    WQ --> RETRY{"Failed?"}
    RETRY -->|"`Retry 2x
    exp. backoff`"| WQ
    RETRY -->|Still failed| ABORT(["`**Abort** buzzer +
    error msg displayed`"])
    RETRY -->|Success| RESULTS[("`Results map
    segment index to text`")]

    STOP([Recording stops]) --> STOPUI["`Chime 660Hz
    waveform → thinking display`"]
    STOPUI --> VADPAUSE["`VAD pause
    (instance kept for
    next recording)`"]
    VADPAUSE --> FLUSHREM["`SegmentAccumulator
    .flushRemaining`"]
    FLUSHREM -->|remaining frames| GATE
    FLUSHREM -.-> DBG_FULL["`Debug: save
    full-recording.wav
    transcript.txt`"]:::debug
    FLUSHREM --> ANYSEG{"`Any segments
    sent?`"}
    ANYSEG -->|No| NOOUT(["`**No output**
    pill hides`"])
    ANYSEG -->|Yes| FINALIZE["`WhisperQueue
    .finalize`"]
    FINALIZE --> WAIT["`Wait for all
    in-flight requests`"]
    WAIT --> CONCAT["`Concatenate results
    in segment order`"]
    CONCAT --> TRANSCRIPT["`**Raw transcript**
    with segment split markers`"]
    TRANSCRIPT --> EMPTY{"`Transcript
    empty?`"}
    DIRECT --> EMPTY
    EMPTY -->|Yes| NOOUT
    EMPTY -->|No| LLMCHECK{"`LLM formatting
    enabled?`"}
    LLMCHECK -->|Yes| LLMREADY{"`Custom LLM
    warmed up?
    (other providers: always)`"}
    LLMCHECK -->|No| STRIPMARKERS["`Strip split markers`"]
    LLMREADY -->|Yes| LLMPASS["`**LLM API**
    postProcessTranscript
    fix punctuation, fillers
    remove split markers`"]
    LLMREADY -->|"`No: skip,
    avoid cold-load wait`"| STRIPMARKERS
    LLMPASS -->|Success| PASTE["`outputText
    (paste | type | save to clipboard)`"]
    LLMPASS -->|"`Error, empty or
    over-length → fallback`"| STRIPMARKERS
    STRIPMARKERS --> PASTE
    PASTE -.- OUTFB["`Fallbacks:
    no ydotool → clipboard
    type: untypable chars → paste,
    failure → clipboard
    paste: prior clipboard
    restored after ~3s`"]:::note

    VADINIT -->|"`No - WASM or
    model load failed
    [Fallback Path]`"| MR["`**MediaRecorder**
    webm/opus`"]
    MR --> FIRSTCHUNK["`Wait: first encoded chunk
    ≤2s timeout
    → start chime`"]
    FIRSTCHUNK --> MRACTIVE["`MediaRecorder active
    (API limit: 30s)`"]
    MRACTIVE -->|Recording stops| BLOB["`Single audio Blob`"]
    BLOB -.-> DBG_FB["`Debug: save
    full-recording.webm/.ogg
    transcript.txt`"]:::debug
    BLOB --> DIRECT["`transcribeAudioBlob
    single API call`"]

    classDef debug fill:#2d2d3d,stroke:#666,stroke-dasharray: 5 5,color:#999
    classDef note fill:#1f2937,stroke:#4b5563,color:#d1d5db
    style WQ fill:#1a2744,stroke:#3b82f6,color:#93c5fd
    style START fill:#14532d,stroke:#22c55e,color:#86efac
    style STOP fill:#7f1d1d,stroke:#ef4444,color:#fca5a5
    style MIC fill:#312e81,stroke:#818cf8,color:#c7d2fe
    style VAD fill:#1e3a5f,stroke:#60a5fa,color:#bfdbfe
    style CA fill:#1e3a5f,stroke:#60a5fa,color:#bfdbfe
    style MR fill:#3b3b1a,stroke:#ca8a04,color:#fde68a
    style ABORT fill:#7f1d1d,stroke:#ef4444,color:#fca5a5
    style NOOUT fill:#2d2d3d,stroke:#9ca3af,color:#e5e7eb
    style LLMPASS fill:#3b1f5e,stroke:#a855f7,color:#e9d5ff
    style TRANSCRIPT fill:#1a3a2a,stroke:#4ade80,color:#bbf7d0
    style PASTE fill:#14532d,stroke:#22c55e,color:#86efac
```
