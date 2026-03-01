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

const isDev = !app.isPackaged;

app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("enable-accelerated-2d-canvas");

let isWayland = false;
try {
  isWayland = process.env.XDG_SESSION_TYPE === "wayland";
} catch (e) {}

// Toggle recording: show+record or stop+hide
function toggleRecording() {
  if (mainWindow) {
    if (!isRecording) {
      mainWindow.show();
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
  const winWidth = 320;
  const winHeight = 80;
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    minWidth: 320,
    minHeight: 360,
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Toggle Recording (Shift+Space)",
      click: () => {
        toggleRecording();
      },
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => {
        createSettingsWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Wisper - Voice Dictation");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    toggleRecording();
  });
}

// IPC Handlers
ipcMain.handle("hide-window", async () => {
  if (mainWindow) {
    mainWindow.hide();
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
    require('fs').appendFileSync('/tmp/wisper.log', `error: ${err.message}\n`);
  }
  return true;
});

ipcMain.handle("get-recording-state", async () => {
  return isRecording;
});

ipcMain.on("set-recording-state", (event, state) => {
  isRecording = state;
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

    globalShortcut.unregisterAll();

    if (!isWayland) {
      globalShortcut.register("Ctrl+Alt+Space", () => {
        toggleRecording();
      });
    } else if (mainWindow) {
      localShortcut.register(mainWindow, "Ctrl+Alt+Space", () => {
        toggleRecording();
      });
    }
  });
}

app.on("window-all-closed", () => {
  // Keep app running in tray
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  if (tray) {
    tray.destroy();
  }
});
