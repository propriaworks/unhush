---
title: Using Local Models — Unhush
---

# Using Local Models with Unhush

Running Unhush entirely locally gives you:

- **Complete privacy** — audio never leaves your machine
- **No API costs** — no usage fees or rate limits
- **Offline use** — works without an internet connection

Both the transcription (speech-to-text) and LLM formatting steps can be run locally and independently. You can mix and match: for example, use a local transcription server with a cloud LLM, or vice versa. For good fully local performance, you'll want to choose models that can both fit in memory at the same time and ideally run on and Nvidia GPU.

---

## Local Transcription — speaches

[**speaches**](https://speaches.ai) is the recommended self-hosted Whisper server. It exposes an OpenAI-compatible `/v1/audio/transcriptions` speech-to-text endpoint and supports GPU acceleration via faster-whisper. Speaches also supports Text-to-Speech models, but this is not used by Unhush and need not be configured.

### Speaches Setup

**Using Docker (simplest approach)**

You'll need Docker Engine with the Compose plugin. If you don't already have them, the quickest way on any Linux dist is `curl -fsSL https://get.docker.com | sh`. Or follow the [distro-specific instructions](https://docs.docker.com/engine/install/) (this covers both the Engine and the Compose plugin).

Start speaches once to pull the image (pick the line matching your hardware):

```bash
# Nvidia GPU with CDI support (most Nvidia users on recent systems):
docker compose -f https://github.com/speaches-ai/speaches.git#master:compose.cuda-cdi.yaml up --detach

# Nvidia GPU without CDI:
docker compose -f https://github.com/speaches-ai/speaches.git#master:compose.cuda.yaml up --detach

# CPU only (other GPUs are not supported)
docker compose -f https://github.com/speaches-ai/speaches.git#master:compose.cpu.yaml up --detach
```

**Without Docker:** speaches can also be run from source using `uv` — see the [speaches installation docs](https://speaches.ai/installation/):

```bash
git clone https://github.com/speaches-ai/speaches.git
cd speaches
uv python install
uv venv && source .venv/bin/activate
uv sync
uvicorn --factory --host 0.0.0.0 speaches.main:create_app
```

Install `uv` via `curl -LsSf https://astral.sh/uv/install.sh | sh` if you don't have it.

### Download a Whisper Text-to-Speech model for Speaches

Pick a model from the table below. A good multilingual default is `Systran/faster-whisper-large-v3` if you have the GPU and memory.

Then download (replacing the model name as needed) using either of these two approaches:

```bash
# the curl API approach:
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-large-v3

# the speaches-cli apprach (if you have `uv` installed):
SPEACHES_BASE_URL="http://localhost:8000" uvx speaches-cli model download Systran/faster-whisper-large-v3
```

The download may take a few minutes. After that, Unhush can start speaches automatically via the Start Command (see below) — you won't need to run speaches manually again.


### Unhush settings (Transcription tab)

| Setting | Value |
|---------|-------|
| Provider | **Custom** |
| API URL | `http://localhost:8000/v1/audio/transcriptions` |
| Model name | Exact model name as downloaded (e.g. `Systran/faster-whisper-large-v3`) |
| Start Command | *(optional)* eg: `docker compose -f https://github.com/speaches-ai/speaches.git#master:compose.cuda-cdi.yaml up --detach` |

Replace `compose.cuda-cdi.yaml` with whichever variant you need (see setup above). Docker Compose caches the repo locally after the first run, so this is fast and works offline after that. Unhush runs the command automatically if speaches isn't up and responding when you try to record.

### Recommended models

| Model | Size | Language | Notes |
|-------|------|----------|-------|
| `Systran/faster-whisper-large-v3` | ~3 GB | Multilingual | Best accuracy; recommended default |
| `Systran/faster-whisper-medium` | ~1.5 GB | Multilingual | Good balance of speed and accuracy |
| `Systran/faster-whisper-small` | ~470 MB | Multilingual | Fast; lower accuracy |
| `Systran/faster-distil-whisper-large-v3` | ~1.5 GB | **English only** | Fast and accurate, but English only |
| `Systran/faster-distil-whisper-small.en` | ~150 MB | **English only** | Very fast; English only |

- **Note:** `distil-whisper` models are English-only — they will transcribe non-English speech as English regardless of input language. Use a non-distilled model for multilingual use.

- To list all models available for download: `SPEACHES_BASE_URL="http://localhost:8000" uvx speaches-cli registry ls --task automatic-speech-recognition | jq '.data[].id' | sort` (requires `uv` and `jq`)

---

## Local LLM Formatting — ollama

[**ollama**](https://ollama.com) is the simplest way to run local LLMs on Linux. It installs as a system service, exposes an OpenAI-compatible `/v1/chat/completions` endpoint, and manages model downloads automatically.

### Setup

```bash
# Install ollama (runs as a system service automatically after install)
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (see recommendations below)
ollama pull llama3.1:8b
```

### Unhush settings (Formatting tab)

| Setting | Value |
|---------|-------|
| Provider | **Custom** |
| API URL | `http://localhost:11434/v1/chat/completions` *(this is the default)* |
| Model name | Exact name as pulled, e.g. `llama3.1:8b` or `gemma3:4b` |
| Start Command | *(optional)* `ollama serve` |

The Start Command is only needed if ollama isn't running as a service. Most installs don't need it; the model will load upon first request.

### Model recommendations

Use a model with at least 8B parameters for reliable punctuation correction and filler-word removal. Smaller models can produce erratic results.

| Model | Size | Notes |
|-------|------|-------|
| `gemma3:4b` | ~3 GB | Rare model under 8b that works well; good if 8B is too big or slow |
| `llama3.1:8b` | ~5 GB | Good quality; recommended minimum |

If neither model runs well locally, consider using a cloud provider (Groq's free tier works well) or disabling LLM formatting altogether — the raw Whisper output is still quite good. If you have the scope for larger models, they do tend to work even better.

---

## Auto-start and warm-up

### Start Command

The optional **Start Command** field (in Settings, under Custom for either provider) lets Unhush launch the server automatically. On each recording, Unhush health-checks the endpoint. If it doesn't respond and a Start Command is set, Unhush runs it and waits up to 15 seconds for the server to come up before proceeding.

### Warm-up

After a server starts (or after it hasn't been used for ~5 minutes), Unhush sends a silent warm-up request to pre-load the model into GPU memory as soon as dictation begins. This reduces or even eliminates the long first-request latency you'd otherwise see when the model is loaded on demand.

---

## Troubleshooting

Check `~/.config/unhush/logs/unhush.log` for detailed error messages.

**Server not starting**
- Run the Start Command manually in a terminal to see its output
- Confirm the endpoint is reachable: `curl http://localhost:8000/v1/models` (speaches) or `curl http://localhost:11434/v1/models` (ollama)

**Wrong model name**
- The model name in Settings must match exactly what the server reports. Check via the `/v1/models` endpoint above, or look at the speaches web interface at `http://localhost:8000`, or run `ollama list` to see the models you have `pull`ed.

**Slow first transcription**
- This is expected — the model is being loaded into GPU memory. Warm-up should prevent it on subsequent recordings. Check `~/.config/unhush/logs/unhush.log` for `warm-up` entries if it persists.

**Health check or warm-up failing**
- Check `~/.config/unhush/logs/unhush.log` for `Health check failed` or `warm-up failed` lines
- Confirm the API URL in Settings includes the full path (e.g. `/v1/audio/transcriptions`, not just the host)
