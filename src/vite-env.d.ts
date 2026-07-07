/// <reference types="vite/client" />

export {};

declare global {
  type OutputMethod = "paste" | "type" | "clipboard";
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
      updateShortcut: (shortcut: string) => Promise<boolean>;
      getShortcutMode: () => Promise<"native" | "gsettings" | "manual">;
      setDuckingConfig: (config: { amount: number }) => void;
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
