const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  clipboard,
  globalShortcut,
  dialog,
} = require("electron");
const path = require("path");
const { exec } = require("child_process");
const waylandShortcut = require("./waylandShortcut.cjs");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isRecording = false;
let currentShortcut = "Ctrl+Alt+Space";
let lastTranscript = null;

const isDev = !app.isPackaged;
const appIcon = path.join(__dirname, isDev ? "../assets/icon-dev.png" : "../assets/icon.png");

let logFile = null;
function log(level, message) {
  if (!logFile) {
    // shouldn't happen — log() is only called after app is ready
    console.error(`[pre-ready log] ${level.toUpperCase()}: ${message}`);
    return;
  }
  const now = new Date();
  const localISO = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
  const line = `[${localISO}] ${level.toUpperCase()}: ${message}\n`;
  fs.appendFileSync(logFile, line);
  if (isDev) console.log(line.trimEnd());
}
waylandShortcut.init(log);

app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("enable-accelerated-2d-canvas");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

let isWayland = false;
try {
  isWayland = process.env.XDG_SESSION_TYPE === "wayland";
} catch (e) {}

if (isWayland) {
  // Enable XDG GlobalShortcuts portal so globalShortcut works on Wayland
  // via the desktop environment (KDE, GNOME 48+).
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

async function registerShortcut(shortcut) {
  globalShortcut.unregisterAll();

  try {
    await globalShortcut.register(shortcut, () => { toggleRecording(); });
  } catch (e) {}

  // On Wayland without portal support, globalShortcut does nothing.
  // Prompt the user to configure a desktop environment shortcut instead.
  if (isWayland && waylandShortcut.needsFallback()) {
    waylandShortcut.check(shortcut);
  }

  currentShortcut = shortcut;
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const preview = lastTranscript
    ? `"${lastTranscript.slice(0, 45)}${lastTranscript.length > 45 ? "…" : ""}"`
    : null;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Toggle Recording (${currentShortcut})`,
      click: () => { toggleRecording(); },
    },
    { type: "separator" },
    ...(preview ? [
      {
        label: `Copy last: ${preview}`,
        click: () => {
          clipboard.writeText(lastTranscript);
          clipboard.writeText(lastTranscript, 'selection');
        },
      },
      { type: "separator" },
    ] : []),
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

function createWindow(offsetFromBottom) {
  const { screen } = require("electron");
  const { x: areaX, y: areaY, width, height } = screen.getPrimaryDisplay().workArea;
  const winWidth = 340;
  const winHeight = 90;
  const x = Math.round(areaX + (width - winWidth) / 2);
  const y = Math.round(areaY + height - winHeight - offsetFromBottom);

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
    icon: appIcon,
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });


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

function createSettingsWindow(tab = null) {
  if (settingsWindow) {
    if (tab) settingsWindow.webContents.send("navigate-tab", tab);
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    minWidth: 320,
    minHeight: 360,
    width: 600,
    height: 720,
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
    icon: appIcon,
    title: "Wisper Settings",
  });

  if (isDev) {
    settingsWindow.loadURL(`http://localhost:5173/settings.html${tab ? `?tab=${tab}` : ""}`);
  } else {
    settingsWindow.loadFile(
      path.join(__dirname, "../dist/settings.html"),
      tab ? { query: { tab } } : {}
    );
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function createTray() {
  const iconPath = appIcon;
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

function saveClipboard() {
  const saved = {};
  const formats = clipboard.availableFormats();
  if (formats.some(f => f.startsWith('text/plain'))) saved.text = clipboard.readText();
  if (formats.some(f => f.startsWith('text/html'))) saved.html = clipboard.readHTML();
  if (formats.some(f => f.startsWith('image/'))) saved.image = clipboard.readImage();
  if (formats.some(f => f.startsWith('text/rtf'))) saved.rtf = clipboard.readRTF();

  const selSaved = {};
  const selFormats = clipboard.availableFormats('selection');
  if (selFormats.some(f => f.startsWith('text/plain'))) selSaved.text = clipboard.readText('selection');
  if (selFormats.some(f => f.startsWith('text/html'))) selSaved.html = clipboard.readHTML('selection');
  if (selFormats.some(f => f.startsWith('image/'))) selSaved.image = clipboard.readImage('selection');
  if (selFormats.some(f => f.startsWith('text/rtf'))) selSaved.rtf = clipboard.readRTF('selection');

  return { clipboard: saved, selection: selSaved };
}

function restoreClipboard(saved) {
  if (Object.keys(saved.clipboard).length > 0) clipboard.write(saved.clipboard);
  if (Object.keys(saved.selection).length > 0) clipboard.write(saved.selection, 'selection');
}

ipcMain.handle("output-text", async (event, text, method) => {
  const { execSync } = require("child_process");

  if (!text) {
    log('info', 'output-text: no text to output');
    return true;
  }

  log('info', `output-text: ${method} (${text.length} chars)`);
  lastTranscript = text;
  updateTrayMenu();

  async function doPaste() {
    const saved = saveClipboard();
    clipboard.writeText(text);
    clipboard.writeText(text, 'selection');
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      execSync('ydotool key --key-delay 20 42:1 110:1 110:0 42:0', { timeout: 5000, stdio: 'ignore' });
    } catch (err) {
      log('error', `output-text paste key simulation failed: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    restoreClipboard(saved);
  }

  try {
    switch (method) {
      case "paste":
        await doPaste();
        break;
      case "type": {
        // Use a random temp filename to prevent symlink race attacks on a predictable path
        const tempFile = path.join(os.tmpdir(), `wisper-${crypto.randomBytes(8).toString('hex')}.txt`);
        try {
          fs.writeFileSync(tempFile, text);
          await new Promise(resolve => setTimeout(resolve, 250));
          const timeout = Math.max(5000, text.length * 50);
          // Note: Previously we used a --delay 100 to give time for the OS focus to return to the target app; seems no longer needed (?)
          execSync(`ydotool type --key-delay 12 --file ${tempFile}`, { timeout, stdio: 'ignore' });
        } finally {
          try { fs.unlinkSync(tempFile); } catch {}
        }
        break;
      }
      case "clipboard":
        clipboard.writeText(text);
        clipboard.writeText(text, 'selection');
        break;
      default:
        log('warn', `output-text: unknown method "${method}", falling back to paste`);
        await doPaste();
    }
  } catch (err) {
    log('error', `output-text (${method}) failed: ${err.message}`);
  }
  return true;
});

ipcMain.on("log", (_event, level, message) => {
  log(level, message);
});

ipcMain.handle("spawn-detached", async (event, command) => {
  const { spawn } = require("child_process");
  try {
    log("info", `spawn-detached: ${command}`);
    const child = spawn(command, { shell: true, detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    log("error", `spawn-detached failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
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

ipcMain.handle("get-shortcut-mode", () => {
  if (!isWayland) return "native";
  return waylandShortcut.shortcutMode();
});

// Warn once if /dev/uinput isn't accessible (AppImage users, or post-install udev not yet active).
// Skipped when output mode is 'clipboard' since ydotool isn't needed in that case.
function checkUinputAccess() {
  const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFilePath, "utf8")); } catch (e) {}

  const outputMode = settings.outputMode || "paste";
  if (outputMode === "clipboard") return;

  // Sentinel file so we only warn once
  const warnedFlag = path.join(app.getPath("userData"), ".uinput-warned");
  if (fs.existsSync(warnedFlag)) return;

  try {
    fs.accessSync("/dev/uinput", fs.constants.W_OK);
    return; // accessible — nothing to do
  } catch (e) {}

  // Not accessible: show guidance
  try { fs.writeFileSync(warnedFlag, ""); } catch (e) {}

  const udevCmd = `echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/80-uinput.rules`;
  const reloadCmd = `sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput`;

  dialog.showMessageBox({
    type: "warning",
    title: "Setup needed for ydotool",
    message: "/dev/uinput is not accessible",
    detail:
      "Wisper uses ydotool to paste text, which requires\nwrite access to /dev/uinput.\n\n" +
      "To give permission, run these two commands in a\nterminal (click 'Copy commands' to copy them):\n\n" +
      `~~~~\n${udevCmd}\n\n` +
      `${reloadCmd}\n~~~~\n\n` +
      "On systemd-based systems this takes effect immediately.\n\n" +
      "Alternatively, switch to Clipboard mode in Settings\n(then you paste manually with Ctrl+V).\n",
    buttons: ["OK", "Copy commands", "Open Settings"],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 1) {
      clipboard.writeText(`${udevCmd}\n${reloadCmd}`);
    } else if (response === 2) {
      createSettingsWindow("usability");
    }
  });
}

// Single-instance toggle: on Wayland without portal support (GNOME < 48, wlroots compositors),
// the global hotkey is a manual desktop env. keyboard shortcut that simply re-launches Wisper.
// The new instance fails to acquire the lock, logs the toggle, and quits immediately.
// The running instance receives "second-instance" and toggles recording.
// On X11 and portal-capable Wayland (KDE, GNOME 48+) this path is not used for the hotkey,
// but re-running Wisper manually will still toggle recording as a convenient fallback.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // We are the second instance — signal the first instance to toggle and exit.
  log("info", "Signalling running instance to toggle recording and quitting");
  app.quit();
} else {
  app.on("second-instance", () => {
    log("info", "Received second-instance signal: toggling recording");
    if (mainWindow) {
      toggleRecording();
    }
  });

  app.whenReady().then(() => {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'wisper.log');

    Menu.setApplicationMenu(null);
    const offsetFromBottom = 45; /* window bottom from desktop bottom) */
    createWindow(offsetFromBottom);
    createTray();
    checkUinputAccess();

    // Reposition the recording bar whenever the primary display's work area changes
    // (resolution change, taskbar resize, monitor added/removed, etc.)
    let repositionTimer = null;
    function repositionMainWindow() {
      clearTimeout(repositionTimer);
      // Debounced: display events fire mid-reconfiguration; the DE may not have
      // re-registered its panel struts yet, so workArea is transiently the full
      // screen bounds. Waiting 500ms lets it settle before we reposition.
      repositionTimer = setTimeout(() => {
        if (!mainWindow) return;
        const { screen } = require("electron");
        const { x: areaX, y: areaY, width, height } = screen.getPrimaryDisplay().workArea;
        const [winWidth, winHeight] = mainWindow.getSize();
        mainWindow.setPosition(
          Math.round(areaX + (width - winWidth) / 2),
          Math.round(areaY + height - winHeight - offsetFromBottom)
        );
      }, 500);
    }
    const { screen } = require("electron");
    screen.on("display-added", repositionMainWindow);
    screen.on("display-removed", repositionMainWindow);
    screen.on("display-metrics-changed", repositionMainWindow);

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
      // Validate that both subdir and filename stay within the debug root (prevent path traversal)
      const BASE_DEBUG_DIR = "/tmp/wisper-debug";
      const debugDir = path.resolve(path.join(BASE_DEBUG_DIR, subdir));
      if (!debugDir.startsWith(BASE_DEBUG_DIR + path.sep) && debugDir !== BASE_DEBUG_DIR)
        throw new Error("Path traversal attempt in subdir");
      fs.mkdirSync(debugDir, { recursive: true });
      filePath = path.join(debugDir, path.basename(filename)); // basename prevents traversal via filename
    } else {
      // Legacy style: auto-generate filename from timestamp
      extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
      const now = new Date();
      const timestamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1).replace(/[:.]/g, "-");
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
  // Chromium doesn't reliably remove its Mojo IPC channel files from userData.
  // Only the main instance cleans up — the second instance must not touch files
  // that the main instance may still be using.
  if (gotTheLock) {
    const dir = app.getPath("userData");
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^\.org\.chromium\.Chromium\.[A-Za-z0-9]+$/.test(f))
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
    } catch (_) {}
  }
});

process.on("SIGINT", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (tray) {
    tray.destroy();
  }
});
