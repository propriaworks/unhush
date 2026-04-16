const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Recording control
  onStartRecording: (callback) => ipcRenderer.on("start-recording", callback),
  onStopRecording: (callback) => ipcRenderer.on("stop-recording", callback),
  setRecordingState: (state) => ipcRenderer.send("set-recording-state", state),
  getRecordingState: () => ipcRenderer.invoke("get-recording-state"),

  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),
  outputText: (text, method) => ipcRenderer.invoke("output-text", text, method),

  // Window control
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  resizeWindow: (width, height) =>
    ipcRenderer.send("resize-window", width, height),

  // Settings
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", callback),
  onNavigateTab: (callback) => ipcRenderer.on("navigate-tab", callback),
  updateShortcut: (shortcut) => ipcRenderer.invoke("update-shortcut", shortcut),
  getShortcutMode: () => ipcRenderer.invoke("get-shortcut-mode"),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Logging
  log: (level, message) => ipcRenderer.send("log", level, message),

  // Process management
  spawnDetached: (command) => ipcRenderer.invoke("spawn-detached", command),

  // Debug
  saveDebugAudio: (arrayBuffer, mimeType, subdir, filename) =>
    ipcRenderer.invoke("save-debug-audio", arrayBuffer, mimeType, subdir, filename),
});
