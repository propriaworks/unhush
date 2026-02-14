# Wisper

Wisper is a WisprFlow-like voice dictation application for Linux. It provides seamless voice-to-text integration using AI transcription, allowing you to dictate anywhere and have text typed directly at your cursor.

## Features

- **Global Hotkey** - Press `Shift+Space` to start/stop recording from anywhere
- **Direct Text Input** - Transcribed text is typed directly at your cursor (no copy-paste needed)
- **AI Transcription** - Transcribe audio using OpenAI Whisper via Groq or OpenAI APIs
- **Multilingual** - Supports 99+ languages with automatic detection
- **Minimal UI** - Slim, transparent recording bar with real-time audio waveform
- **System Tray** - Quick access to settings and app controls
- **Compact Settings** - Configure API keys in a dedicated window
- **Wayland & X11 Support** - Works on both display servers
- **Privacy First** - Records locally before sending to API

## Requirements

- Linux (Debian/Ubuntu 22.04+)
- Microphone access
- Internet connection (for API calls)
- **ydotool** - Required for direct text input (install via your package manager)
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

```bash
# Ubuntu/Debian
sudo apt install ydotool

# Fedora
sudo dnf install ydotool

# Arch Linux
sudo pacman -S ydotool
```

### From Release

Download the latest `.AppImage` or `.deb` package from the [Releases](https://github.com/taraksh01/wisper/releases) page.

## Usage

### First Time Setup

1. Right-click the system tray icon and select **Settings**
2. Choose your API provider:
   - **Groq**: Free, fast Whisper models (recommended)
   - **OpenAI**: Official Whisper API
3. Enter your API key
4. Click **Save**

### Recording

1. Press `Shift+Space` to start recording (bar appears)
2. Speak into your microphone
3. Press `Shift+Space` again to stop
4. Text is transcribed and typed directly at your cursor

### System Tray

- **Left-click**: Toggle recording
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

Wisper supports two transcription providers:

| Provider | Model | Cost | Get API Key |
|----------|-------|------|-------------|
| **Groq** (Recommended) | `whisper-large-v3-turbo` | Free | [console.groq.com](https://console.groq.com/) |
| **OpenAI** | `whisper-1` | Paid | [platform.openai.com](https://platform.openai.com/api-keys) |

### Settings

Access settings via system tray → **Settings**

| Option | Description |
|--------|-------------|
| Provider | Choose between Groq and OpenAI |
| API Key | Your provider's API key |

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
- Ensure ydotool is installed
- Check permissions: `sudo chmod 666 /dev/uinput`
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
