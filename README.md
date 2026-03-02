# Wisper

Wisper is a WisprFlow-like voice dictation application for Linux. It provides seamless voice-to-text integration using AI transcription, allowing you to dictate anywhere and have text typed directly at your cursor.

## Features

- **Global Hotkey** - Press hotkey to start/stop recording from anywhere
- **Direct Text Input** - Transcribed text is typed directly at your cursor (no copy-paste needed)
- **AI Transcription** - Transcribe audio using OpenAI Whisper via Groq or OpenAI APIs
- **Multilingual** - Supports 99+ languages with automatic detection
- **Minimal UI** - Slim, transparent recording bar with real-time audio waveform
- **System Tray** - Quick access to settings and app controls
- **Compact Settings** - Configure API keys in a dedicated window
- **Wayland & X11 Support** - Works on both display servers
- **Privacy First** - Records locally before sending to API. The API endpoint can be local too (e.g. see [`speaches`](https://speaches.ai))

## Requirements

- Linux (Debian/Ubuntu 22.04+)
- Microphone access
- Internet connection (for API calls)
- **ydotool** - Used for direct text input (install instructions below)
- **Wayland users**: Need to set up custom keyboard shortcut (see Wayland Setup below)

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/taraksh01/wisper.git
cd wisper

# Install dependencies
pnpm install

# Run in development
pnpm run electron:dev

# Build for production
pnpm run build
pnpm run package
```

### Install ydotool

[`ydotool`](https://github.com/ReimuNotMoe/ydotool) is responsible for sending the speech output into the active input field.

Pre-packaged versions are available but may be older versions:

```bash
# Ubuntu/Debian
sudo apt install ydotool

# Fedora
sudo dnf install ydotool

# Arch Linux
sudo pacman -S ydotool
```

In case of trouble (see #Troubleshooting), you may want to use the [latest release](https://github.com/ReimuNotMoe/ydotool/releases/latest):

**Installing and running `ydotoold` as a service** is also recommended. This improves responsiveness and reliability. If your package manager doesn't provide a service config (as ubuntu's doesn't), you can get the `systemd` config [here](https://github.com/ReimuNotMoe/ydotool/raw/refs/heads/master/Daemon/systemd/ydotoold.service.in). Save it as `$HOME/.config/systemd/user/ydotoold.service`, and edit so that `ExecStart` points to `which ydotoold`. Then do this once:

```sh
systemctl --user daemon-reload
systemctl --user start ydotoold   # runs service as the current user
systemctl --user status ydotoold  # check that it's successfully running
systemctl --user enable ydotoold  # to run it automatically at boot
```

### From Release

Download the latest `.AppImage` or `.deb` package from the [Releases](https://github.com/taraksh01/wisper/releases) page.

## Usage

### First Time Setup

1. Right-click the system tray icon and select **Settings**
2. Choose your API provider:
   - **Groq**: Free, fast Whisper models (recommended)
   - **OpenAI**: Official Whisper API
   - **Custom**: Any OpenAI transcription-API-compatible model endpoint (e.g. locally-served)
3. Enter your API key (optional for custom)
4. Choose Wisper's *hotkey* (`Shift-Space` by default)
5. Click **Save**

### Recording

1. Press your *hotkey* to start recording (bar appears)
2. When the chime sounds and the bar turns red, **Speak into your microphone**
3. Press your *hotkey* again to stop
4. Text is transcribed and typed directly at your cursor location

### System Tray

- **Left-click**: Toggle recording (same has hotkey-press)
- **Right-click**: Open menu (Settings, Quit)

## Wayland Setup (GNOME/Debian)

On Wayland, global shortcuts must be configured through your desktop environment.

### Set Up Keyboard Shortcut

1. Open **Settings** → **Keyboard** → **Keyboard Shortcuts** → **View and Customize Shortcuts**
2. Scroll to bottom and click **Custom Shortcuts**
3. Click **Add Shortcut** (+)
4. Configure:
   - **Name**: `Wisper Toggle`
   - **Command**: `wisper` (or path to AppImage)
   - **Shortcut**: Press `Shift+Space`
5. Click **Add**

**Note**: Running Wisper while it's already running will toggle recording (single-instance behavior).

For AppImage:
```bash
/path/to/Wisper.AppImage --no-sandbox
```

For development:
```bash
/usr/bin/electron /path/to/wisper --no-sandbox
```

## Configuration

### API Keys

Wisper supports these transcription providers:

| Provider | Model | Cost | Get API Key |
|----------|-------|------|-------------|
| **Groq** (Recommended) | `whisper-large-v3-turbo` | Free | [console.groq.com](https://console.groq.com/) |
| **OpenAI** | `whisper-1` | Paid | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Custom** | Any OpenAI API'd ASR model | Free if local |  |

### Settings

Access settings via system tray → **Settings**

| Option | Description |
|--------|-------------|
| Provider | Choose between Groq, OpenAI and Custom |
| API Key | Your provider's API key |
| Shortcut | *Shift-Space*, *Ctrl-Alt-Space*, *Ctrl-Shift-Space*, *Ctrl-Shift-Insert*, or *Alt-F12* |

## Building

```bash
# Development
pnpm run dev              # Start Vite dev server only
pnpm run electron:dev     # Start Electron with hot reload

# Production
pnpm run build            # Build React app
pnpm run package          # Create distributables (.AppImage, .deb)
```

## Troubleshooting

### ydotool not working
- You will see an error in `/tmp/wisper.log`, or test manually with `ydotool type "some text"`. "some text" should appear in the terminal.
- Ensure ydotool is installed
- The user running `wisper` needs write access to `/dev/uinput`. Either: `sudo chmod 666 /dev/uinput`, or follow [this procedure](https://github.com/ReimuNotMoe/ydotool/issues/36#issuecomment-788148567)
- For Wayland, ydotool may require additional setup

### Global shortcut not working on Wayland
- Set up a custom keyboard shortcut in GNOME Settings (see Wayland Setup above)
- The app uses single-instance lock, so running it again toggles recording

### Microphone access denied
- Grant microphone permission in system settings
- Check if another app is using the microphone exclusively

### Transcription failing
- Verify your API key is correct in Settings
- Check your internet connection
- Groq has rate limits on free tier - wait and retry

## License

MIT License - see LICENSE file for details

## Author

Tarak Shaw - [@taraksh01](https://github.com/taraksh01)

## Acknowledgments

- Inspired by [WisprFlow](https://wisprflow.com)
