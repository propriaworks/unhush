/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    electronAPI: {
      onStartRecording: (callback: () => void) => void;
      onStopRecording: (callback: () => void) => void;
      setRecordingState: (state: boolean) => void;
      getRecordingState: () => Promise<boolean>;
      copyToClipboard: (text: string) => Promise<boolean>;
      pasteToCursor: (text: string) => Promise<boolean>;
      hideWindow: () => Promise<void>;
      resizeWindow: (width: number, height: number) => void;
      onOpenSettings: (callback: () => void) => void;
      removeAllListeners: (channel: string) => void;
      saveDebugAudio: (arrayBuffer: ArrayBuffer, mimeType: string) => Promise<string | null>;
    };
  }
}
