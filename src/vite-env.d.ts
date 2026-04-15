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
      copyToClipboard: (text: string) => Promise<boolean>;
      outputText: (text: string, method: OutputMethod) => Promise<boolean>;
      hideWindow: () => Promise<void>;
      resizeWindow: (width: number, height: number) => void;
      onOpenSettings: (callback: () => void) => void;
      updateShortcut: (shortcut: string) => Promise<boolean>;
      getShortcutMode: () => Promise<"native" | "gsettings" | "manual">;
      removeAllListeners: (channel: string) => void;
      log: (level: "info" | "warn" | "error", message: string) => void;
      saveDebugAudio: (arrayBuffer: ArrayBuffer, mimeType: string, subdir?: string, filename?: string) => Promise<string | null>;
      spawnDetached: (command: string) => Promise<{ ok: boolean; pid?: number; error?: string }>;
    };
  }
}
