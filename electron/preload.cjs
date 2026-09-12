const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Recording control
  onStartRecording: (callback) => ipcRenderer.on("start-recording", callback),
  onStopRecording: (callback) => ipcRenderer.on("stop-recording", callback),
  setRecordingState: (state) => ipcRenderer.send("set-recording-state", state),
  getRecordingState: () => ipcRenderer.invoke("get-recording-state"),
  getDefaultMicSource: () => ipcRenderer.invoke("get-default-mic-source"),

  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),
  outputText: (text, method) => ipcRenderer.invoke("output-text", text, method),

  // Window control
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  resizeWindow: (width, height) =>
    ipcRenderer.send("resize-window", width, height),

  // Setup dialog (electron/setup-dialog.html) — see electron/ydotool.cjs
  ydotoolPreflight: () => ipcRenderer.invoke("ydotool-preflight"),
  // outputMethod, when given, is the mode Settings should select on arrival (see
  // "Use Clipboard mode instead"): the renderer owns that setting, so it does the write.
  openSettings: (tab, outputMethod) =>
    ipcRenderer.invoke("open-settings-window", tab, outputMethod),
  closeSetupDialog: () => ipcRenderer.send("close-setup-dialog"),
  setSetupDialogMuted: (muted) => ipcRenderer.send("set-setup-dialog-muted", muted),
  onSetupResult: (callback) => ipcRenderer.on("setup-result", callback),

  // Settings
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", callback),
  onNavigateTab: (callback) => ipcRenderer.on("navigate-tab", callback),
  onSetOutputMethodUiSetting: (callback) => ipcRenderer.on("set-output-method-ui-setting", callback),
  updateShortcut: (shortcut) => ipcRenderer.invoke("update-shortcut", shortcut),
  // How the global shortcut is managed here, plus the command a desktop-environment shortcut
  // should run (see electron/waylandShortcut.cjs and electron/commandFifo.cjs).
  getShortcutInfo: () => ipcRenderer.invoke("get-shortcut-info"),
  configureShortcut: () => ipcRenderer.invoke("configure-shortcut"),
  setDuckingConfig: (config) => ipcRenderer.send("set-ducking-config", config),
  setOutputMethod: (method) => ipcRenderer.send("set-output-method", method),
  // "Start at login" (systemd --user unit; unsupported on AppImage/dev -- see get-autostart-status)
  getAutostartStatus: () => ipcRenderer.invoke("get-autostart-status"),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Logging
  log: (level, message) => ipcRenderer.send("log", level, message),

  // Process management
  spawnDetached: (command) => ipcRenderer.invoke("spawn-detached", command),

  // Custom-provider health signals — reasonKey is an independent cause (e.g. "config",
  // "badurl", "runtime", "warmup", "unreachable"); each clears on its own without
  // affecting other active reasons.
  setFormatterWarning: (reasonKey, on) => ipcRenderer.send("set-formatter-warning", reasonKey, on),
  setTranscriptionWarning: (reasonKey, on) => ipcRenderer.send("set-transcription-warning", reasonKey, on),
  onRecheckConfig: (callback) => ipcRenderer.on("recheck-config", callback),

  // Debug
  saveDebugAudio: (arrayBuffer, mimeType, subdir, filename) =>
    ipcRenderer.invoke("save-debug-audio", arrayBuffer, mimeType, subdir, filename),
});
