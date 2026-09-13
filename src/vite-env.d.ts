/// <reference types="vite/client" />

export {};

declare global {
  type OutputMethod = "paste" | "type" | "clipboard";
  // Mirrors the reasonKey shape validateTranscriptionConfig/validateLLMConfig already produce --
  // see setProviderStatus above and electron/providerSetup.cjs.
  interface ProviderStatus {
    transcription: { provider: "groq" | "openai" | "custom"; reason: "config" | "badurl" | null };
    formatter: { provider: "none" | "groq" | "openai" | "custom"; reason: "config" | "badurl" | null };
  }
  const __APP_VERSION__: string;
  interface Window {
    electronAPI: {
      onStartRecording: (callback: () => void) => void;
      onStopRecording: (callback: () => void) => void;
      setRecordingState: (state: boolean) => void;
      getRecordingState: () => Promise<boolean>;
      // Name of the source the system "default" mic resolves to ("" if unknown/not Linux)
      getDefaultMicSource: () => Promise<string>;
      copyToClipboard: (text: string) => Promise<boolean>;
      outputText: (text: string, method: OutputMethod) => Promise<boolean>;
      hideWindow: () => Promise<void>;
      resizeWindow: (width: number, height: number) => void;
      onOpenSettings: (callback: () => void) => void;
      onNavigateTab: (callback: (event: unknown, tab: string) => void) => void;
      // Tells Settings' output-method buttons which one to select in the UI, sent when the
      // settings window is already open (a fresh one gets it in the query string instead -- see
      // createSettingsWindow). Distinct from setOutputMethod below: that one *reports* the real,
      // persisted setting from Settings to main; this one *commands* Settings to select a value.
      onSetOutputMethodUiSetting: (callback: (event: unknown, method: string) => void) => void;
      updateShortcut: (shortcut: string) => Promise<boolean>;
      getShortcutInfo: () => Promise<{
        // native: we hold the key grab (X11). portal: the desktop holds it for us (Wayland).
        // manual: no portal here, so the user binds `command` themselves.
        mode: "native" | "portal" | "manual";
        command: string;
        // The portal's own description of the live key; "" means every trigger is disabled.
        trigger: string | null;
        canConfigure: boolean;
      }>;
      configureShortcut: () => Promise<{ ok: boolean; error?: string }>;
      setDuckingConfig: (config: { amount: number }) => void;
      // Reported at mount and on change: the main process can't read localStorage, and the
      // first-run setup check skips the ydotool problems entirely in clipboard mode.
      setOutputMethod: (method: OutputMethod) => void;
      // "Start at login": supported is false on AppImage/dev (no systemd unit shipped there).
      getAutostartStatus: () => Promise<{ supported: boolean; enabled: boolean }>;
      setAutostart: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      // Reported alongside the tray-warning signals below: drives the setup window's provider
      // cards (referral only -- see electron/providerSetup.cjs). Never an API key.
      setProviderStatus: (status: ProviderStatus) => void;
      removeAllListeners: (channel: string) => void;
      log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
      saveDebugAudio: (arrayBuffer: ArrayBuffer, mimeType: string, subdir?: string, filename?: string) => Promise<string | null>;
      spawnDetached: (command: string) => Promise<{ ok: boolean; pid?: number; error?: string }>;

      // Custom-provider health signals — reasonKey is an independent cause (e.g. "config",
      // "runtime", "warmup"); each clears on its own without affecting other active reasons.
      setFormatterWarning: (reasonKey: string, on: boolean) => void;
      setTranscriptionWarning: (reasonKey: string, on: boolean) => void;
      onRecheckConfig: (callback: () => void) => void;
    };
  }
}
