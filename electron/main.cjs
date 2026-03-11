const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  clipboard,
  globalShortcut,
} = require("electron");
const localShortcut = require("electron-localshortcut");
const path = require("path");
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isRecording = false;
let currentShortcut = "Shift+Space";

const isDev = !app.isPackaged;

const LOG_FILE = '/tmp/wisper.log';
function log(level, message) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
  if (isDev) console.log(line.trimEnd());
}

app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("enable-accelerated-2d-canvas");

let isWayland = false;
try {
  isWayland = process.env.XDG_SESSION_TYPE === "wayland";
} catch (e) {}

async function registerShortcut(shortcut) {
  if (!isWayland) {
    globalShortcut.unregisterAll();
    try {
      await globalShortcut.register(shortcut, () => {
        toggleRecording();
      });
    } catch {}
  } else if (mainWindow) {
    localShortcut.unregisterAll(mainWindow);
    localShortcut.register(mainWindow, shortcut, () => {
      toggleRecording();
    });
  }
  currentShortcut = shortcut;
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Toggle Recording (${currentShortcut})`,
      click: () => { toggleRecording(); },
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => { createSettingsWindow(); },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => { app.quit(); },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// Toggle recording: show+record or stop+hide
function toggleRecording() {
  if (mainWindow) {
    if (!isRecording) {
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setAlwaysOnTop(true);
      mainWindow.webContents.send("start-recording");
      isRecording = true;
    } else {
      mainWindow.webContents.send("stop-recording");
      isRecording = false;
    }
  }
}

function createWindow() {
  const { screen } = require("electron");
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const winWidth = 340;
  const winHeight = 90;
  const x = Math.round((width - winWidth) / 2);
  const y = Math.round(height - winHeight - 20);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 200,
    minHeight: 60,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    type: "notification",   // Linux: _NET_WM_WINDOW_TYPE_NOTIFICATION — excludes from Alt-Tab, atom is pre-cached by Chromium
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // disable cors checks, same-origin policy, mixed content blocking, file:// isolation, so we can load from APIs that don't send cors headers
    },
    icon: path.join(__dirname, "../assets/icon.png"),
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Window is shown once at startup (transparent + click-through).
  // All subsequent visibility changes are handled via setIgnoreMouseEvents
  // to avoid OS window-manager sounds on every recording toggle.
  // Window is shown once at startup (transparent + click-through + not on top).
  // All subsequent visibility changes use setIgnoreMouseEvents / setAlwaysOnTop
  // to avoid OS window-manager sounds on every recording toggle.
  mainWindow.once("ready-to-show", () => {
    mainWindow.setIgnoreMouseEvents(true);
    mainWindow.setAlwaysOnTop(false);
  });

  // Inject settings.json into localStorage on load
  const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
  mainWindow.webContents.once("did-finish-load", () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(settingsFilePath, "utf8"));
      for (const [key, value] of Object.entries(cfg)) {
        const lsKey = `wisper_${key}`;
        const lsValue = typeof value === "string" ? value : JSON.stringify(value);
        mainWindow.webContents.executeJavaScript(
          `localStorage.setItem(${JSON.stringify(lsKey)}, ${JSON.stringify(lsValue)})`
        );
      }
      log("info", `Loaded settings from ${settingsFilePath}`);
    } catch (e) {
      if (e.code !== "ENOENT") log("warn", `Failed to read settings.json: ${e.message}`);
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    minWidth: 320,
    minHeight: 360,
    height: 630,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: path.join(__dirname, "../assets/icon.png"),
    title: "Wisper Settings",
  });

  if (isDev) {
    settingsWindow.loadURL("http://localhost:5173/settings.html");
  } else {
    settingsWindow.loadFile(path.join(__dirname, "../dist/settings.html"));
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "../assets/icon.png");
  const icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    return;
  }

  const trayIcon = icon.resize({ width: 22, height: 22 });
  tray = new Tray(trayIcon);

  tray.setToolTip("Wisper - Voice Dictation");
  updateTrayMenu();

  tray.on("click", () => {
    toggleRecording();
  });
}

// IPC Handlers
ipcMain.handle("hide-window", async () => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(true);
    mainWindow.setAlwaysOnTop(false);
    isRecording = false;
  }
});

ipcMain.handle("copy-to-clipboard", async (event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("paste-to-cursor", async (event, text) => {
  const { execSync } = require("child_process");

  try {
    const tempFile = '/tmp/wisper-text.txt';
    require('fs').writeFileSync(tempFile, text);
    // Wait for the window to hide and the OS to return focus to the target app
    await new Promise(resolve => setTimeout(resolve, 250));
    const timeout = Math.max(5000, text.length * 50);
    // key delay (how fast the text is written) may be something worth exposing to the user
    execSync(`ydotool type --delay 100 --key-delay 15 --file ${tempFile}`, { timeout, stdio: 'ignore' });
  } catch (err) {
    log('error', `paste-to-cursor failed: ${err.message}`);
  }
  return true;
});

ipcMain.on("log", (_event, level, message) => {
  log(level, message);
});

ipcMain.handle("get-recording-state", async () => {
  return isRecording;
});

ipcMain.on("set-recording-state", (event, state) => {
  isRecording = state;
});

ipcMain.handle("update-shortcut", async (event, shortcut) => {
  await registerShortcut(shortcut);
  return true;
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      toggleRecording();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
    // shortcut registration will occur (via IPC) immediately after the renderer loads
  });
}

ipcMain.handle("save-debug-audio", async (event, arrayBuffer, mimeType, subdir, filename) => {
  try {
    let extension, filePath;
    if (subdir && filename) {
      // New style: save to /tmp/wisper-debug/{subdir}/{filename}
      const debugDir = path.join("/tmp/wisper-debug", subdir);
      fs.mkdirSync(debugDir, { recursive: true });
      filePath = path.join(debugDir, filename);
    } else {
      // Legacy style: auto-generate filename from timestamp
      extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const debugDir = "/tmp/wisper-debug";
      fs.mkdirSync(debugDir, { recursive: true });
      filePath = path.join(debugDir, `recording-${timestamp}.${extension}`);
    }
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return filePath;
  } catch (err) {
    console.error("Failed to save debug audio:", err);
    return null;
  }
});

app.on("window-all-closed", () => {
  // Keep app running in tray
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

process.on("SIGINT", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (tray) {
    tray.destroy();
  }
});
