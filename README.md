# Wisper

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-actively--maintained-brightgreen)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

Wisper is a fast, system-wide voice dictation application for Linux.

Wisper provides seamless speech-to-text using AI transcription, allowing you to dictate anywhere and have text delivered instantly. It offers functionality comparable to *Wispr Flow* (a commercial voice dictation app for Windows and macOS).

This is an independent, actively maintained fork of [taraksh01/wisper](https://github.com/taraksh01/wisper), focused on improving usability, robustness, and extending core functionality.

## Features

- **Global Hotkey** - Press hotkey to start/stop recording from anywhere
- **Flexible Output** - Choose how transcribed text is delivered: **Paste** (default, instant, clipboard-based), **Type** (character-by-character via ydotool), or **Clipboard** (copy only, paste manually)
- **AI Transcription** - Transcribe audio using the OpenAI Whisper model, via Groq, OpenAI, or any compatible local/custom endpoint
- **Unlimited Recording Length** - Voice Activity Detection (VAD) segments long dictations at natural pauses; each segment is sent to Whisper concurrently, so there is no time limit on recordings
- **LLM Formatting Pass** - Optional post-processing by an LLM to fix punctuation, remove filler words, and clean up speech artefacts
- **Multilingual** - Supports 99+ languages with automatic detection
- **Minimal UI** - Slim, transparent recording bar with real-time audio waveform
- **System Tray** - Quick access to settings and app controls
- **Wayland & X11 Support** - Works on both display servers
- **Privacy First** - Records locally before sending to API. Both the transcription and formatting endpoints can be local (e.g. [`speaches`](https://speaches.ai) for Whisper, [`ollama`](https://ollama.com) for LLM) for *total privacy*
- **Auto-start & Warm-up** - Wisper can start local servers automatically on first use and pre-load models into GPU memory to reduce first-request latency

## Requirements

- Linux (Debian 10+ / Ubuntu 22.04+ / Fedora 32+ / Arch Linux) with native packages, or anything with AppImage and glibc 2.29+ (which includes Ubuntu 18.04+)
- Microphone access
- Internet connection (for cloud API calls) or a local Whisper server (see below)
- **ydotool** — Required for **Paste** (default) and **Type** output modes; not needed for **Clipboard** mode
  - `.deb` / `.rpm` / `.pkg.tar.zst` installs: ydotool is installed automatically as a package dependency
  - AppImage: install ydotool manually (see below)

## Installation

### As a package

Download the latest release from the [Releases](https://github.com/jtbr/wisper/releases) page and install:

```bash
sudo apt install ./wisper_*.deb          # Debian / Ubuntu / Mint
sudo dnf install ./wisper-*.rpm          # Fedora / RHEL
sudo pacman -U wisper-*.pkg.tar.zst      # Arch / Manjaro
```

To verify your download against the [SHA256 checksums](https://github.com/jtbr/wisper/releases/latest/download/SHA256SUMS.txt):

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

The `.deb`, `.rpm`, and `.pkg.tar.zst` packages automatically:
- Install ydotool as a dependency
- Configure `/dev/uinput` access (required by ydotool) via a udev rule — no manual steps or re-login needed

#### Additional steps for AppImage only

[`ydotool`](https://github.com/ReimuNotMoe/ydotool) sends transcribed text to the active input field, so is normally required, unless you want to paste manually using the clipboard. AppImage users need to install it themselves; it's normally available via platform package managers.

In case of trouble (see [Troubleshooting](#troubleshooting)), you may want to use the [latest release](https://github.com/ReimuNotMoe/ydotool/releases/latest).

At startup, Wisper will show a one-time dialog with setup instructions if `/dev/uinput` isn't accessible.


### From Source

```bash
# Clone the repository
git clone https://github.com/jtbr/wisper.git
cd wisper

# Install dependencies
pnpm install

# Run in development
pnpm run electron:dev
```


### Running `ydotoold` as a service

This is recommended — it improves responsiveness and avoids the small startup delay on each dictation. If your package manager doesn't provide a service config (Ubuntu's doesn't), get the `systemd` config [here](https://github.com/ReimuNotMoe/ydotool/raw/refs/heads/master/Daemon/systemd/ydotoold.service.in). Save it as `$HOME/.config/systemd/user/ydotoold.service`, edit `ExecStart` to point to `which ydotoold`, then run once:

```sh
systemctl --user daemon-reload
systemctl --user enable --now ydotoold
```

## Usage

### First Time Setup

1. Right-click the system tray icon and select **Settings**
2. Choose your transcription provider:
   - **Groq**: Free, fast Whisper models (recommended)
   - **OpenAI**: Official Whisper API
   - **Custom**: Any OpenAI transcription-API-compatible endpoint (e.g. locally-served)
3. Enter your API key (optional for custom)
4. Optionally configure a **Formatting** (LLM) provider for post-processing
5. On the **Usability** tab, choose your **Output** method (default: **Paste**):
   - **Paste**: Text is pasted instantly via clipboard — works in terminals and GUI apps, atomic, no cursor-move corruption
   - **Type**: Characters typed one-by-one via ydotool — slower, lets you watch text appear as it's written
   - **Clipboard**: Text is copied to clipboard only — paste manually with Ctrl+V; no ydotool required
6. On the **Usability** tab, choose Wisper's *hotkey* (`Ctrl+Alt+Space` by default)

### Recording

1. Press your *hotkey* to start recording (bar appears)
2. When the chime sounds and the bar turns red, **speak into your microphone** — there is no time limit
3. Press your *hotkey* again to stop — a second chime plays and a thinking indicator appears while your speech is transcribed
4. Text is delivered to your cursor — pasted instantly by default (see Output mode in Settings)

### System Tray

- **Left-click**: Toggle recording (same as hotkey-press)
- **Right-click**: Open menu (Settings, Quit)

## Wayland Setup

Global shortcut handling on X11 works seemlessly. On Wayland it depends on your desktop environment:

| Desktop | Behaviour |
|---|---|
| **KDE Plasma** | Works automatically via the XDG GlobalShortcuts portal. On first launch, KDE shows a dialog to confirm the shortcut binding. |
| **GNOME 48+** (Ubuntu 25.04+, Fedora 42+) | Works automatically via the portal, same as KDE. |
| **GNOME < 48** (Ubuntu 24.04 LTS) | On first launch, Wisper automatically configures a desktop keyboard shortcut via `gsettings`. |
| **Other compositors** (Sway, Hyprland, etc.) | On first launch, Wisper shows a one-time dialog with instructions to add a custom shortcut in your compositor's config. |

### Manual shortcut setup

**Note**: Running Wisper again while it's already running will *toggle recording*. This is what the keyboard shortcut calls — no matter how Wisper was installed, the shortcut just runs `wisper` (or the AppImage path) again.

If you need to configure the shortcut yourself, add a custom keyboard shortcut in your Desktop Evironment's settings with the command:

- **Package install**: `wisper`
- **AppImage**: `/path/to/Wisper.AppImage --no-sandbox`
- **Development**: `pnpm run electron /path/to/wisper --no-sandbox`

## Configuration

### Transcription

| Provider | Model | Cost | Get API Key |
|----------|-------|------|-------------|
| **Groq** (Recommended) | `whisper-large-v3-turbo` | Free tier | [console.groq.com](https://console.groq.com/keys) |
| **OpenAI** | `whisper-1` | Paid | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Custom** | Any OpenAI-compatible ASR endpoint | Free if local | — |

For the **Custom** provider, set the full endpoint URL (e.g. `http://localhost:8000/v1/audio/transcriptions`) and the model name as the server expects it. [`speaches`](https://speaches.ai) is a good self-hosted option.

### LLM Formatting (optional)

After transcription, Wisper can send the raw transcript to an LLM to clean it up: fixing punctuation, removing filler words ("um", "uh"), and correcting verbal course corrections. The system prompt is fully editable in settings.

| Provider | Default model | Cost | Notes |
|----------|--------------|------|-------|
| **Groq** | `llama-3.3-70b-versatile` | Free tier | Uses your Groq API key from the transcription tab |
| **OpenAI** | `gpt-4.1-mini` | Paid | Uses your OpenAI API key from the transcription tab |
| **Custom** | — | Free if local | Default URL: `http://localhost:11434/v1/chat/completions` ([ollama](https://ollama.com)) |

For the **Custom** provider, it's best to use a model with at least 8B parameters to work reasonably well and avoid problems. If you can't run that locally and don't want to use another service, you can disable LLM formatting altogether. The results are still mostly pretty good.

### Local / Custom Servers

For both the transcription and LLM providers, the optional **Start Command** field (under Custom settings) lets Wisper auto-start the server when it isn't running. On first recording, Wisper health-checks each configured custom endpoint. If the check fails and a start command is set, it runs that command and waits up to 15 seconds for the server to respond before proceeding.

Wisper also sends a warm-up request to each custom endpoint on first use (and periodically thereafter, if it hasn't been used for 5 minutes [by default]) to pre-load the model into GPU memory. This avoids the long first-request delay that occurs when models are loaded on demand.

#### Speaches custom local transcription - Docker setup

If you don't already have [`speaches`](https://speaches.ai), but you have `docker compose` you can set it to run automatically with zero install simply by adding `docker compose -f https://github.com/speaches-ai/speaches.git#master:compose.cuda-cdi.yaml up --detach` as the transcription start command (this `yaml` file assumes you have an Nvidia GPU with CDI support, adjust as necessary). The first time you're running you'll need to [download a Whisper STT model as described here](https://speaches.ai/usage/model-discovery/#__tabbed_1_2), for example `Systran/faster-distil-whisper-large-v3`. That's it!

### Settings Reference

| Setting | Where | Description |
|---------|-------|-------------|
| Provider | Transcription tab | Groq, OpenAI, or Custom |
| API Key | Transcription tab | Provider API key |
| API URL | Transcription tab (Custom) | Full transcription endpoint URL |
| Model name | Transcription tab (Custom) | Model identifier as the server expects |
| Start Command | Transcription tab (Custom) | Shell command to launch the server if not running (e.g. `speaches serve`) |
| Output | Usability tab | How text is delivered: `Paste` (default), `Type`, or `Clipboard` |
| Shortcut | Usability tab | Global hotkey |
| Formatting provider | Formatting tab | None, Groq, OpenAI, or Custom |
| Language Model | Formatting tab | LLM model name |
| API URL | Formatting tab (Custom) | Full chat completions endpoint URL |
| API Key | Formatting tab (Custom) | Optional bearer token |
| Start Command | Formatting tab (Custom) | Shell command to launch the LLM server (e.g. `ollama serve`) |
| System Prompt | Formatting tab | Instructions sent to the LLM; editable |

## Troubleshooting

Wisper logs to `/tmp/wisper.log`. When something goes wrong, check there first.

### Text not being typed / ydotool not working

If you're using **Paste** (default) or **Type** output mode, Wisper depends on ydotool. Switch to **Clipboard** mode in Settings to eliminate this dependency entirely (you will need to paste the result yourself).

- Test manually: `ydotool type "hello"` — the word should appear in your terminal
- Ensure ydotool is installed (`.deb`/`.rpm`/`.pkg.tar.zst` installs it automatically; AppImage users need to install it manually)
- Ensure the daemon (`ydotoold`) is running — running it as a user systemd service is recommended (see [Install ydotool](#install-ydotool-appimage-only))
- **`/dev/uinput` not accessible**: `.deb`/`.rpm`/`.pkg.tar.zst` installs configure this automatically via a udev rule. AppImage users will see a one-time setup dialog on first use; follow the instructions shown, or run:
  ```bash
  echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
    | sudo tee /etc/udev/rules.d/80-uinput.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```
  In case this should fail, you can also explicitly add yourself to the input group: `usermod -aG input <USER>`.

### Global shortcut not working on Wayland

- **KDE / GNOME 48+**: On first launch, a system dialog should appear asking you to confirm the shortcut. If you dismissed it, restart Wisper to re-trigger it.
- **GNOME < 48**: Wisper configures this automatically on first launch. If it failed, set it up manually in GNOME Settings → Keyboard → Custom Shortcuts (see [Manual shortcut setup](#manual-shortcut-setup)).
- **Other compositors**: Add a custom shortcut in your compositor config that runs `wisper` (or the AppImage path).
- Running `wisper` again from the command line always toggles recording regardless of how shortcuts are configured.

### Microphone access denied

- Grant microphone permission in system settings
- Check if another application has exclusive microphone access

### Transcription errors

When transcription fails, Wisper plays a buzzer sound, displays the error message in the recording pill for ~3.5 seconds, then dismisses. Nothing is typed. Common messages:

| Message | Likely cause |
|---------|-------------|
| `Whisper server unreachable` | Custom server isn't running. Set a **Start Command** in Settings, or start it manually |
| `Network error` | No internet connection (Groq/OpenAI), or blocked by IP address |
| `Bad API key` | API key is missing or invalid — check Settings |
| `Rate limited` | Hit the provider's rate limit — wait a moment and retry |
| `Bad endpoint URL` | Custom URL is wrong — it must include the full path, e.g. `/v1/audio/transcriptions` |
| `Whisper server error` | Server returned 5xx — check the server's own logs |

### Custom server: health check or warm-up failing

- Check `/tmp/wisper.log` for `Health check failed` or `warm-up` entries
- Confirm the server is running: `curl http://localhost:8080/v1/models`
- Confirm the model name in Settings matches exactly what the server reports in the models list
- If auto-start is configured, check that the command works when run manually in a terminal

### Transcription is slow on first recording

This is normal when using a local server — the model needs to be loaded into GPU memory. Wisper sends a warm-up request on first use to trigger this early. If warm-up isn't helping, check `/tmp/wisper.log` for warm-up errors.

### LLM formatting not working

- Ensure the Formatting provider is set (not "Off") in the Formatting tab
- For Custom: verify the API URL points to a `/v1/chat/completions` endpoint and the model name is correct
- Check `/tmp/wisper.log` for `LLM post-processing failed` errors
- The raw transcript is used as fallback if the LLM call fails, so dictation still works

## Development

This is actively maintained; your contributions and feedback are welcome.

### Building

Cross-format building is supported with native system tools:

| Host | Extra setup | Builds |
|------|-------------|--------|
| Ubuntu / Debian | `sudo apt install rpm fakeroot` | AppImage, .deb, .rpm |
| Fedora / RHEL | `sudo dnf install dpkg fakeroot` | AppImage, .deb, .rpm |
| Arch Linux | *(none — base-devel sufficient)* | AppImage, .pkg.tar.zst |

```bash
# Production
pnpm run build            # Build React app
pnpm run package          # Create distributables for all targets supported on this host
```

The `.pkg.tar.zst` package is built in CI using an Arch Linux container and is not cross-buildable from other distributions.

### Testing

Some aspects of Wayland and many Linux distributions have not been tested directly. Please share your experiences in the [discussions](https://github.com/jtbr/wisper/discussions/2), particularly with respect to the hotkey functionality.

### Releases

Update version in `package.json`, commit final changes, then tag it and push:

```bash
git tag v3.1.0 && git push origin v3.1.0
```

CI/CD will be launched by github to build it, save release builds and update docs/index.html with version correct download links.
To test, open a draft PR or do Actions -> CI -> Run workflow, and pick a branch (to re-release, pick the tag instead).

## Why this fork?

The original project introduced a strong foundation and compelling visualizations.

This fork continues that work with a focus on making the project more practical, extensible, and production-ready.

> The original project has had no activity since February 2026.

### Key Improvements

- Improved usability, configuration, and consistency
- Enhanced logging and error visibility+handling
- Support for custom/local models, including startup and warmup
- Support for unlimited dictation time (overcoming Whisper-model limitation)
- Added LLM-based post-processing
- Seamless installation and Wayland support

## License

MIT License - see [LICENSE](LICENSE) file for details

## Authors

- Justin Briggs - [@jtbr](https://github.com/jtbr) — Extended functionality, improved usability and robustness, and added post-processing capabilities
- Tarak Shaw - [@taraksh01](https://github.com/taraksh01) — Original creator; implemented core architecture and visualizations

> A pull request with initial improvements from this fork was submitted upstream but has not received a response as of April 2026