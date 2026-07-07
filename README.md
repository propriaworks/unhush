# [<img alt="Unhush mic" src="docs/mic_button_sm.png" width="40" height="40" align="top" style="margin-right: 8px" />](https://unhush.propriaworks.com) Unhush

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-actively--maintained-brightgreen)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

Unhush is a fast, system-wide voice input application for Linux.

For the longest time, computer input has been quiet. Just keyboard and mouse. No longer. Unlock the power of your voice with *Unhush*, for at least 3x faster input.

Unhush provides seamless speech-to-text using AI transcription, allowing you to dictate anywhere and have text delivered instantly. It offers functionality comparable to *Wispr Flow* (a commercial voice dictation app for Windows and macOS).

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
- **Privacy First** - Records locally before sending to API. Both the transcription and formatting endpoints can be local for *total privacy* — see [Using Local Models](docs/local-models.md)
- **Auto-start & Warm-up** - Unhush can start local servers automatically on first use and pre-load models into GPU memory to reduce first-request latency
- **Attenuate Background Audio** - Optionally lowers other apps' volume while recording (with a smooth ramp, not an abrupt cut), so ambient music or notifications don't compete with your voice

## Requirements

- Linux (Debian 10+ / Ubuntu 22.04+ / Fedora 32+ / Arch Linux) with native packages, or anything with AppImage and glibc 2.29+ (which includes Ubuntu 18.04+)
- Microphone access
- Internet connection (for cloud API calls) or a local Whisper server (see below)
- **ydotool** — Required for **Paste** (default) and **Type** output modes; not needed for **Clipboard** mode
  - `.deb` / `.rpm` / `.pacman` installs: ydotool is installed automatically as a package dependency
  - AppImage: install ydotool manually (see below)
- **xprop** (X11 sessions only, optional) — enables the "sent ➜ \<app\>" tray indicator (see [System Tray](#system-tray)); harmless if absent, the tray just won't show a destination
  - Usually already installed (it's a base X11 utility). `.deb` installs recommend it automatically; `.rpm`/`.pacman`/AppImage: install manually if missing — `x11-utils` (Debian/Ubuntu), `xprop` (Fedora/RHEL), `xorg-xprop` (Arch)
  - Not applicable on Wayland sessions (see [Wayland Setup](#wayland-setup) for what's supported there instead)

## Installation

<details open>
<summary>As a system package</summary>

Download the latest release from the [Releases](https://github.com/propriaworks/unhush/releases) page and install:

```bash
sudo apt install ./unhush_*.deb          # Debian / Ubuntu / Mint
sudo dnf install ./unhush-*.rpm          # Fedora / RHEL
sudo pacman -U unhush-*.pacman           # Arch / Manjaro / etc
```

To verify your download against the [SHA256 checksums](https://github.com/propriaworks/unhush/releases/latest/download/SHA256SUMS.txt):

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

The `.deb`, `.rpm`, and `.pacman` packages automatically:
- Install ydotool as a dependency
- Configure `/dev/uinput` access (required by ydotool) via a udev rule — no manual steps or re-login needed
</details>

<details>
<summary>AppImage</summary>

Download and run the AppImage, no installation needed (after making it executable).

Unhush uses [`ydotool`](https://github.com/ReimuNotMoe/ydotool) to send transcribed text to the active input field, so is normally required, unless you want to instead manually paste using the clipboard. AppImage users need to install it themselves; it's normally available via platform package managers.

In case of trouble (see [Troubleshooting](#troubleshooting)), you may want to use the [latest release](https://github.com/ReimuNotMoe/ydotool/releases/latest).

`ydotool` needs write access to `/dev/uinput`. At startup, Unhush will show a one-time dialog with setup instructions if it isn't already accessible.

On X11 sessions, also install `xprop` if you want the tray's "sent ➜ \<app\>" indicator (package name varies by distro — see [Requirements](#requirements)); it's optional and everything else works fine without it.
</details>

<details>
<summary>From Source</summary>

```bash
# Clone the repository
git clone https://github.com/propriaworks/unhush.git
cd unhush

# Install dependencies
pnpm install

# Run in development mode
pnpm run electron:dev
```

### Running `ydotoold` as a service (optional, recommended)

Using the `ydotoold` daemon improves responsiveness and avoids the small startup delay on each dictation. If your package manager doesn't provide a service config (Ubuntu's doesn't), get the `systemd` config [here](https://github.com/ReimuNotMoe/ydotool/raw/refs/heads/master/Daemon/systemd/ydotoold.service.in). Save it as `$HOME/.config/systemd/user/ydotoold.service`, edit `ExecStart` to point to `which ydotoold`, then run once:

```sh
systemctl --user daemon-reload
systemctl --user enable --now ydotoold
```
</details>

## Usage

### First Time Setup

1. Right-click the system tray icon and select **Settings**
2. Choose your transcription provider:
   - **Groq**: Free, fast Whisper models
   - **OpenAI**: Official Whisper API, good if you have a subscription
   - **Custom**: Any OpenAI transcription-API-compatible endpoint (e.g. *recommended* [locally-served](docs/local-models.md) for those who can)
3. Enter your API key from [Groq](https://console.groq.com/keys) or [OpenAI](https://platform.openai.com/api-keys) (optional for custom)
4. Optionally configure a **Formatting** (LLM) provider for post-processing
5. On the **Usability** tab, choose your **Output** method (default: **Paste**):
   - **Paste**: Text is pasted instantly via clipboard — works in terminals and GUI apps, atomic, no cursor-move corruption
   - **Type**: Characters typed one-by-one via ydotool — slower, lets you watch text appear as it's written
   - **Clipboard**: Text is copied to clipboard only — paste manually with Ctrl+V; no `ydotool` required
6. On the **Usability** tab, choose Unhush's *hotkey* (`Ctrl+Alt+Space` by default)

### Recording

1. Press your *hotkey* to start recording (bar appears)
2. When the chime sounds and the bar turns red, **speak into your microphone** — there is no time limit
3. Press your *hotkey* again to stop — a second chime plays and a thinking indicator appears while your speech is transcribed
4. Text is delivered to your cursor — pasted instantly by default (see Output mode in Settings)

### Choosing a Microphone

Unhush records from your **system default input device**. To use a different microphone, change the default in your desktop's sound settings (GNOME: Settings → Sound → Input; KDE: System Settings → Sound), with `pavucontrol` (Input Devices → set fallback), or from a terminal:

```bash
pactl list sources short          # list input devices
pactl set-default-source <name>   # set the default
```

The change takes effect on the next recording — no restart needed.

### System Tray

- **Left-click**: Toggle recording (same as hotkey-press)
- **Right-click**: Open menu (Settings, Copy last transcript, Quit)
- After a **Paste**/**Type** output, the menu shows which app/window received it (e.g. "sent ➜ firefox — some title"), right under "Copy last". This is tray-only and never written to the log file, since window titles can contain sensitive content. Platform support varies:

  | Platform | Support |
  |---|---|
  | X11 | Works via `xprop` (see [Requirements](#requirements)) |
  | Sway / Hyprland | Works natively, no extra setup |
  | GNOME (Wayland) | Requires the [Focused Window D-Bus](https://extensions.gnome.org/extension/5592/focused-window-d-bus/) extension — install it if you want this; otherwise no destination is shown, which is expected |
  | KDE Plasma (Wayland) | Not yet supported — no destination shown (KDE X11 sessions work via the `xprop` path above) |

- A **⚠ badge** appears on the tray icon for transcription failures, missing settings (API key, custom URL/model), or repeated LLM warm-up failures. Hover the icon or open the menu for details; each cause clears independently, and the badge itself clears once none remain.

## Wayland Setup

Global shortcut handling on X11 works seemlessly. On Wayland it depends on your desktop environment.

<details>
<summary>Wayland Shortcut Setup</summary>

| Desktop | Behaviour |
|---|---|
| **KDE Plasma** | Works automatically via the XDG GlobalShortcuts portal. On first launch, KDE shows a dialog to confirm the shortcut binding. |
| **GNOME 48+** (Ubuntu 25.04+, Fedora 42+) | Works automatically via the portal, same as KDE. |
| **GNOME < 48** (Ubuntu 24.04 LTS) | On first launch, Unhush automatically configures a desktop keyboard shortcut via `gsettings`. |
| **Other compositors** (Sway, Hyprland, etc.) | On first launch, Unhush shows a one-time dialog with instructions to manually add a custom shortcut using your compositor's config. |

### Manual shortcut setup

**Note**: Running Unhush again while it's already running will ***toggle** recording*. This is what the keyboard shortcut calls — no matter how Unhush was installed, the shortcut just runs `unhush` (or the AppImage path) again.

If you need to configure the shortcut yourself, add a custom keyboard shortcut in your Desktop Evironment's settings with the command:

- **Package install**: `unhush`
- **AppImage**: `/path/to/Unhush.AppImage` (add `--no-sandbox` if Unhush fails to start)
- **Development**: `pnpm run -C /path/to/unhushrepo electron:dev`
</details>

## Auto-starting Unhush

<details>
<summary>To have Unhush start up automatically</summary>

This can be done in several ways, depending partly upon how you installed:

- **Package install — XDG autostart** (works on GNOME, KDE, XFCE, and most DEs):
  ```bash
  mkdir -p ~/.config/autostart
  cp /usr/share/applications/unhush.desktop ~/.config/autostart/
  ```

- **Package install — Desktop Environment settings**:
  - **GNOME**: open **Settings → Apps → Startup Applications** and add Unhush
  - **KDE Plasma**: open **System Settings → Autostart** and add `/usr/local/bin/unhush`
  - **Other**: most have an Autostart or Session Startup settings configuration; add Unhush as `/usr/local/bin/unhush`

- **Package install — systemd user service**:
  ```bash
  cat > ~/.config/systemd/user/unhush.service << 'EOF'
  [Unit]
  Description=Unhush Voice Dictation

  [Service]
  ExecStart=/usr/local/bin/unhush
  Restart=on-failure

  [Install]
  WantedBy=default.target
  EOF
  systemctl --user enable --now unhush
  ```

- **AppImage**: use Desktop Environment or systemd approaches, substituting `/path/to/Unhush.AppImage` as the command (add `--no-sandbox` if Unhush fails to start).
</details>

## Detailed Configuration

### Transcription

| Provider | Model | Cost | Get API Key |
|----------|-------|------|-------------|
| **Groq** | `whisper-large-v3-turbo` | Free tier for most | [console.groq.com](https://console.groq.com/keys) |
| **OpenAI** | `whisper-1` | Paid | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Custom** | Any OpenAI-compatible transcriptions endpoint | Free if local | — |

For the **Custom** provider, set the server's base URL (e.g. `http://localhost:8000`) and the model name as the server expects it. See [Using Local Models](docs/local-models.md) for setup guides and recommended configuration.

### LLM Formatting (optional)

After transcription, Unhush can send the raw transcript to an LLM to clean it up: fixing punctuation, removing filler words ("um", "uh"), and correcting verbal course corrections. The system prompt is fully editable in Settings.

| Provider | Default model | Cost | Notes |
|----------|--------------|------|-------|
| **Groq** | `llama-3.3-70b-versatile` | Free tier | Uses your Groq API key from the transcription tab |
| **OpenAI** | `gpt-4.1-mini` | Paid | Uses your OpenAI API key from the transcription tab |
| **Custom** | — | Free if local | Default URL: `http://localhost:11434` ([ollama](https://ollama.com)) |

For the **Custom** provider, see [Using Local Models](docs/local-models.md) for setup, model recommendations, and auto-start configuration.

<details>
<summary>Settings Reference</summary>

| Setting | Where | Description |
|---------|-------|-------------|
| Provider | Transcription tab | Groq, OpenAI, or Custom |
| API Key | Transcription tab | Provider API key |
| API URL | Transcription tab (Custom) | Server base URL (no `/v1/...` path — Unhush appends it) |
| Model name | Transcription tab (Custom) | Model identifier as the server expects |
| Start Command | Transcription tab (Custom) | Shell command to launch the server if not running (e.g. `speaches serve`). Re-run automatically the first time, every 2 minutes while the server stays unreachable, whenever it's gone unreached for a while after being up (see `provider_restart_stale_min` below), or right after you close Settings having changed a related field. Must be safe to run more than once |
| Output | Usability tab | How text is delivered: `Paste` (default), `Type`, or `Clipboard` |
| Shortcut | Usability tab | Global hotkey |
| Chimes | Usability tab | Play a short chime when recording starts and stops: `On` (default) or `Off` |
| Attenuate other audio | Usability tab | Lowers other apps' volume while recording, then ramps back up when you stop: `Off`, `40%`, `60%`, or `Mute` (default `40%`). Your own start/stop chimes are never attenuated. Requires PulseAudio or PipeWire (i.e. virtually all Linux desktops) |
| Keep microphone warm | Usability tab | Keeps the microphone open between recordings so the next one starts instantly: `On` or `Off` (default). Useful for microphones that are slow to wake from power saving (common with USB webcam mics). While on, your system's microphone-in-use indicator stays lit, though audio isn't processed or saved except while transcribing |
| Formatting provider | Formatting tab | None, Groq, OpenAI, or Custom |
| Language Model | Formatting tab | LLM model name |
| API URL | Formatting tab (Custom) | Server base URL (no `/v1/...` path — Unhush appends it) |
| API Key | Formatting tab (Custom) | Optional bearer token |
| Start Command | Formatting tab (Custom) | Shell command to launch the LLM server (e.g. `ollama serve`). Re-run automatically the first time, every 2 minutes while the server stays unreachable, whenever it's gone unreached for a while after being up (see `provider_restart_stale_min` below), or right after you close Settings having changed a related field. Must be safe to run more than once |
| System Prompt | Formatting tab | Instructions sent to the LLM; editable |

</details>

<details>
<summary>Advanced Settings</summary>

These settings are not exposed in the UI. Set them by adding keys to `~/.config/unhush/settings.json` (create the file if it doesn't exist). Keys use the setting name without the `unhush_` prefix from the code:

```json
{
  "debug_audio": "true",
  "warmup_interval_sec": "600"
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `debug_audio` | Save each recording's audio segments and transcripts to `/tmp/unhush-debug/` for inspection | `false` |
| `debug_logging` | Include "debug"-level messages in `~/.config/unhush/logs/unhush.log` (normally suppressed, since nothing currently filters log levels otherwise — see [Troubleshooting](#troubleshooting)) | `false` |
| `warmup_interval_sec` | Seconds between warm-up requests to the custom transcription server | `240` |
| `llm_warmup_interval_sec` | Seconds between warm-up requests to the custom LLM server | `240` |
| `provider_restart_stale_min` | Minutes since a custom server (transcription or LLM) was last successfully reached, after which Unhush will re-check it and, if unreachable, re-run its Start Command. Also triggers immediately after editing the Start Command, regardless of this interval | `60` |
| `llm_keep_alive` | For Ollama LLM servers: how long to request the model be kept loaded in VRAM after each dictation. Accepts Ollama duration strings (`"2h"`, `"30m"`) or seconds as a number; `"-1"` pins forever; `""` disbles this feature. Has no effect on non-Ollama servers. | `"2h"` |
| `llm_length_multiplier` | Max LLM output length as a multiple of the input length; output exceeding this is discarded and the raw transcript used instead | `1.1` |
| `llm_excess_length_floor` | Minimum character headroom above input length regardless of multiplier | `20` |
| `llm_final_instructions` | Instruction appended to the user message sent to the LLM, after the transcript | `"Output the cleaned transcript only. No commentary, no explanations, no preamble."` |

Settings in this file are loaded at startup and take precedence over any previously saved values.

</details>

## Troubleshooting

Unhush logs to `~/.config/unhush/logs/unhush.log` (Linux). When something goes wrong, check there first.

<details>
<summary>Text not being typed / ydotool not working</summary>

If you're using **Paste** (default) or **Type** output mode, Unhush depends on ydotool. Switch to **Clipboard** mode in Settings to eliminate this dependency entirely (you will need to paste the result yourself).

- Test manually: `ydotool type "hello"` — the word should appear in your terminal
- Ensure ydotool is installed (`.deb`/`.rpm`/`.pacman` installs it automatically; AppImage users need to install it manually)
- Ensure the daemon (`ydotoold`) is running — running it as a user systemd service is recommended (see [Install ydotool](#install-ydotool-appimage-only))
- **`/dev/uinput` not accessible**: `.deb`/`.rpm`/`.pacman` installs configure this automatically via a udev rule. AppImage users will see a one-time setup dialog on first use; follow the instructions shown, or run:
  ```bash
  echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
    | sudo tee /etc/udev/rules.d/80-uinput.rules
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```
  In case this should fail, you can also explicitly add yourself to the input group: `usermod -aG input <USER>`.
</details>

<details>
<summary>Global shortcut not working on Wayland</summary>

- **KDE / GNOME 48+**: On first launch, a system dialog should appear asking you to confirm the shortcut. If you dismissed it, restart Unhush to re-trigger it.
- **GNOME < 48**: Unhush configures this automatically on first launch. If it failed, set it up manually in GNOME Settings → Keyboard → Custom Shortcuts (see [Manual shortcut setup](#manual-shortcut-setup)).
- **Other compositors**: Add a custom shortcut in your compositor config that runs `unhush` (or the AppImage path).
- Running `unhush` again from the command line always toggles recording regardless of how shortcuts are configured.
</details>

<details>
<summary>Microphone access denied</summary>

- Grant microphone permission in system settings
- Check if another application has exclusive microphone access
</details>

<details>

<summary>No output or bogus output</summary>

- In your system sound settings, ensure that the correct microphone is selected, working, and sensitive enough.
- Sometimes nearly silent input will lead to voice models trying too hard to divine what you said, leading it to output nonsense.
</details>

<details>

<summary>Sometimes text doesn't appear</summary>

- If the cursor is not in an active text box, terminal, or other place that can accept text input, the pasted / typed text may be dropped by the target app. In case this happens, you can right click on the system try icon to find out to which window it was sent (where possible -- not all Wayland compositors support this), and copy the transcription text to clipboard yourself so you can paste again where you need it.
</details>

<details>
<summary>Recording is slow to start (sometimes)</summary>

The chime and red bar appear only once the microphone is actually delivering audio, so a slow start means the device itself is slow to wake. Most systems suspend an idle microphone a few seconds after its last use, and USB mics (especially webcams) may then also be put into USB power saving — waking one can take a second or more. You'd notice that starts are instant when recordings are very close together but slower after a pause.

- Enable **Keep microphone warm** on the Usability tab: Unhush holds the microphone open between recordings so it never gets suspended. Your system's microphone-in-use indicator will stay lit.
- Each start is timed in the log (`Recording start: mic=…ms, …` in `~/.config/unhush/logs/unhush.log`); the `mic=` stage is the device wake.
- Alternatively (advanced), you can prevent the kernel from USB-suspending a specific microphone. Find its vendor/product ID with `lsusb` (e.g. `ID 046d:0825` for a Logitech C270), then install a udev rule with your IDs substituted:

  ```bash
  echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="046d", ATTR{idProduct}=="0825", ATTR{power/control}="on"' \
    | sudo tee /etc/udev/rules.d/50-mic-no-autosuspend.rules
  sudo udevadm control --reload-rules
  ```

  Then unplug and replug the device (or reboot). This disables USB power saving for that one device only; the extra idle draw of a microphone is negligible. See the [Arch wiki on USB autosuspend](https://wiki.archlinux.org/title/Power_management#USB_autosuspend) for background.
</details>

<details>
<summary>Transcription errors</summary>

When transcription fails, Unhush plays a buzzer sound, displays the error message in the recording pill for ~3.5 seconds, then dismisses. Nothing is typed. The tray icon also shows a **⚠ badge** until a transcription succeeds again. Common messages:

| Message | Likely cause |
|---------|-------------|
| `Whisper server unreachable` | Custom server isn't running. Set a **Start Command** in Settings, or start it manually |
| `Network error` | No internet connection (Groq/OpenAI), or blocked by IP address |
| `Bad API key` | API key is missing or invalid — check Settings |
| `Rate limited` | Hit the provider's rate limit — wait a moment and retry |
| `Bad endpoint URL` | Custom URL is wrong — it should be just the server's base URL, e.g. `http://localhost:8000` (no `/v1/...` path) |
| `Whisper server error` | Server returned 5xx — check the server's own logs |
</details>

<details>
<summary>Custom server: health check, warm-up, or slow first transcription</summary>

See [Using Local Models — Troubleshooting](docs/local-models.md#troubleshooting).
</details>

<details>
<summary>LLM formatting not working</summary>

- Ensure the Formatting provider is set (not "Off") in the Formatting tab
- For Custom: verify the API URL is the server's base URL (not a full endpoint path) and the model name is correct
- Check `~/.config/unhush/logs/unhush.log` for `LLM post-processing failed` errors
- The raw transcript is used as fallback if the LLM call fails, so dictation still works
- For Custom: if the tray icon shows a **⚠ badge**, the formatter's warm-up has failed on two dictations in a row — check that the server is running and reachable at the configured API URL
</details>

<details>
<summary>Diagnosing transcription quality or pipeline issues</summary>

Enable debug audio to capture each recording session in detail:

```json
// ~/.config/unhush/settings.json
{ "debug_audio": "true" }
```

Then after each recording, Unhush writes to `/tmp/unhush-debug/<timestamp>/`:

| File | Contents |
|------|----------|
| `full-recording.wav` | Complete raw audio for the session |
| `segment-NNN.wav` | Individual VAD-segmented audio chunks sent to Whisper |
| `transcript.txt` | Per-segment transcription with timing and latency |
| `llm-pass.json` | LLM formatting input/output, status, and latency (if LLM enabled) |
</details>


## Development

This is actively maintained; your contributions and feedback are most welcome.

A diagram of the recording, processing, chunking, postprocessing pipeline workflow is available [here](pipeline.md).

### Testing

Some aspects of Wayland and many Linux distributions have not been tested directly. Please share your experiences in the [discussions](https://github.com/propriaworks/unhush/discussions/10), particularly with respect to the hotkey functionality, and with respect to the paste-destination tray indicator on Sway, Hyprland, and GNOME Wayland (with the Focused Window D-Bus extension installed) — none of these could be tested on the machine this was developed on. KDE Plasma Wayland support for this indicator isn't implemented yet.


<details>
<summary>Developer notes</summary>

Run `pnpm install` to install dependencies.
`pnpm up --latest` updates dependencies to their latest versions.

Before committing check typescript with `pnpm tsc` .

### Fixing OSV-flagged subdependencies

The flagged package is often transitive (e.g. `esbuild`, pulled in by `vite`), so bumping the top-level package won't help. Instead: `pnpm why <package>` to find what requires it, then `pnpm add -D <package>@<fixed-version>` to pin it directly, then `pnpm why <package>` again to confirm it deduped to one version.

### Building

Cross-format building is supported with native system tools:

| Host | Extra setup | Builds |
|------|-------------|--------|
| Ubuntu / Debian | `sudo apt install rpm fakeroot` | AppImage, .deb, .rpm |
| Fedora / RHEL | `sudo dnf install dpkg fakeroot` | AppImage, .deb, .rpm |
| Arch Linux | *(none — base-devel sufficient)* | AppImage, .pacman |

```bash
# Production
pnpm run build       # Build React app
pnpm run package     # Create distributables for all targets supported on this host
```

The `.pacman` package is built in CI using an Arch Linux container and is not cross-buildable from other distributions.

### Releases

Merge PR into main. Then **from the main branch**, pull and update version in `package.json`, update download links with `node scripts/sync-docs.mjs`, and commit changes. Finally tag it, and push the commit along with the tag:

```bash
git commit -m "bump version"
git tag v3.1.0 && git push origin main v3.1.0
```

CI will be launched by github to build it, save release builds and update docs/index.html with version correct download links (if not already done). To test the CI, open a draft PR or do Actions -> CI -> Run workflow, and pick a branch (to rebuild a release, pick the tag instead).

### Other details

Screen recording created using `byzanz` cli.
</details>

## License

MIT License - see [LICENSE](LICENSE) file for details

## Acknowledgments

Unhush was based upon [wisper](https://github.com/taraksh01/wisper), but is now independently maintained.
> The predecessor project has had no activity since February 2026.

### Key Improvements

- Improved usability, configuration, and consistency
- Enhanced logging and error visibility+handling
- Support for custom/local models, including startup and warmup
- Support for unlimited dictation time (overcoming Whisper-model limitation)
- Added LLM-based post-processing
- Seamless installation and Wayland support


### Authors
- Justin Briggs - [@jtbr](https://github.com/jtbr) — Current maintainer
- Tarak Shaw - [@taraksh01](https://github.com/taraksh01) — Original creator; implemented core architecture and visualizations


### Unhush is free software from [Propria Works](https://propriaworks.com). Keep your data yours