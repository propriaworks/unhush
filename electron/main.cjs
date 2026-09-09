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
const { exec, execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const waylandShortcut = require("./waylandShortcut.cjs");
const ydotool = require("./ydotool.cjs");
const audioDucking = require("./audioDucking.cjs");
const activeWindow = require("./activeWindow.cjs");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isRecording = false;
let currentShortcut = "Ctrl+Alt+Space";
let lastTranscript = null;
let lastPasteDestination = null; // { app, title } | null — in-memory only, NEVER passed to log()
let lastHotkeyAt = 0; // when the toggle hotkey last fired — for paste-failure diagnostics timing
// Reason-keyed warning registries. Each entry is one independent cause the renderer has
// reported (bad settings, a runtime failure, a warm-up streak, etc.) — the tray badges
// whenever either set is non-empty, and clears only once every reason in it has cleared,
// so e.g. fixing a missing API key doesn't wipe out an unrelated "server is down" warning.
// See "set-transcription-warning" / "set-formatter-warning" IPC below.
const transcriptionWarnings = new Set();
const formatterWarnings = new Set();
const WARNING_MESSAGES = {
  transcription: {
    config: "Missing transcription API key or model — check Settings",
    badurl: "Transcription API URL is invalid — check Settings",
    runtime: "Transcription failing — check your provider/server",
    unreachable: "Local transcription server unreachable — check it's running",
  },
  formatter: {
    config: "Missing LLM API key or model — check Settings",
    badurl: "LLM API URL is invalid — check Settings",
    warmup: "LLM formatting unavailable — using raw transcript",
    unreachable: "Local LLM server unreachable — check it's running",
  },
};

const isDev = !app.isPackaged;
const appIcon = path.join(__dirname, isDev ? "../assets/icon-dev.png" : "../assets/icon.png");
const appIconWarning = path.join(__dirname, isDev ? "../assets/icon-dev-warning.png" : "../assets/icon-warning.png");

let logFile = null;
let debugLogging = false; // gates "debug"-level messages only — see settings.json's debug_logging
function log(level, message) {
  if (level === "debug" && !debugLogging) return;
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
ydotool.init(log);
audioDucking.init(log, app.getName());
activeWindow.init(log);

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
    await globalShortcut.register(shortcut, () => { lastHotkeyAt = Date.now(); toggleRecording(); });
  } catch (e) {}

  // On Wayland without portal support, globalShortcut does nothing.
  // Prompt the user to configure a desktop environment shortcut instead.
  if (isWayland && waylandShortcut.needsFallback()) {
    waylandShortcut.check(shortcut);
  }

  currentShortcut = shortcut;
  updateTrayMenu();
}

// Builds one "⚠ ..." line per active reason, transcription warnings first.
function activeWarningLines() {
  return [
    ...[...transcriptionWarnings].map((k) => `⚠ ${WARNING_MESSAGES.transcription[k]}`),
    ...[...formatterWarnings].map((k) => `⚠ ${WARNING_MESSAGES.formatter[k]}`),
  ];
}

// Swaps the tray icon/tooltip between normal and warning-badged based on the warning sets.
function updateTrayIcon() {
  if (!tray) return;
  const lines = activeWarningLines();
  const icon = nativeImage.createFromPath(lines.length ? appIconWarning : appIcon);
  if (icon.isEmpty()) return;
  tray.setImage(icon.resize({ width: 22, height: 22 }));
  const base = `Unhush - Voice Input${isDev ? " (devmode)" : ""}`;
  tray.setToolTip(lines.length ? `${base}\n${lines.join("\n")}` : base);
}

function updateTrayMenu() {
  if (!tray) return;
  const preview = lastTranscript
    ? `"${lastTranscript.slice(0, 45)}${lastTranscript.length > 45 ? "…" : ""}"`
    : null;
  const destination = lastPasteDestination
    ? `sent ➜ ${lastPasteDestination.app || "unknown"}${lastPasteDestination.title ? ` — ${lastPasteDestination.title.slice(0, 40)}${lastPasteDestination.title.length > 40 ? "…" : ""}` : ""}`
    : null;
  const warningLines = activeWarningLines();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Toggle Recording (${currentShortcut})`,
      click: () => { toggleRecording(); },
    },
    { type: "separator" },
    ...warningLines.map((label) => ({ label, enabled: false })),
    ...(warningLines.length ? [{ type: "separator" }] : []),
    ...(preview ? [
      {
        label: `Copy last: ${preview}`,
        click: () => {
          clipboard.writeText(lastTranscript);
          clipboard.writeText(lastTranscript, 'selection');
        },
      },
      ...(destination ? [{ label: destination, enabled: false }] : []),
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

// Central recording-state transition: keeps audio ducking in sync wherever isRecording
// changes (hotkey/tray toggle, hide-window, and the renderer's own state confirmation —
// including its start-failure and stop paths). No-op guard avoids double-duck/-restore
// when the renderer's confirmation arrives after toggleRecording() already set the flag.
function setRecordingActive(active) {
  if (active === isRecording) return;
  isRecording = active;
  if (active) audioDucking.duck();
  else audioDucking.restore();
}

// Toggle recording: show+record or stop+hide
function toggleRecording() {
  if (mainWindow) {
    if (!isRecording) {
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setAlwaysOnTop(true);
      mainWindow.webContents.send("start-recording");
      setRecordingActive(true);
    } else {
      mainWindow.webContents.send("stop-recording");
      setRecordingActive(false);
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
      // webSecurity: false is safe here because this window only ever loads our own bundled
      // files (no user-navigable browser, no external URLs, no user-supplied HTML), so there
      // is no vector for a malicious page to exploit the relaxed CORS/same-origin policy.
      // It is required because local AI servers (Speaches, Ollama, etc.) don't send CORS
      // headers — they're designed to be called from native apps, not browsers.
      webSecurity: false, // disable cors checks, same-origin policy, mixed content blocking, file:// isolation
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
        const lsKey = `unhush_${key}`;
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

  // Diagnostics: this app previously had no visibility into renderer crashes — a dead
  // render frame just silently fails IPC sends (see toggleRecording) with no explanation.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log("error", `mainWindow renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("unresponsive", () => {
    log("warn", "mainWindow renderer became unresponsive");
  });
  mainWindow.webContents.on("responsive", () => {
    log("info", "mainWindow renderer responsive again");
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
      // webSecurity: false is safe here because this window only loads our own bundled
      // settings page (no navigation, no external content, no user-supplied HTML), so
      // there is no vector to exploit the relaxed policy. It is required to fetch
      // /v1/models from local AI servers, which don't send CORS headers.
      webSecurity: false,
    },
    icon: appIcon,
    title: "Unhush Settings",
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
    // Settings may have just fixed (or broken) a required field — recheck immediately
    // rather than waiting for the next recording attempt.
    if (mainWindow) mainWindow.webContents.send("recheck-config");
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(appIcon);

  if (icon.isEmpty()) {
    return;
  }

  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  updateTrayIcon();
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
    setRecordingActive(false);
  }
});

ipcMain.handle("copy-to-clipboard", async (event, text) => {
  clipboard.writeText(text);
  clipboard.writeText(text, 'selection'); // PRIMARY too, so middle-click paste works
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
  lastPasteDestination = null; // reset every call so it can't show a stale destination from a prior paste
  updateTrayMenu();

  // Fire-and-forget: never awaited before the paste keystroke below. Detection shells out to
  // xprop/swaymsg/hyprctl/etc. (see activeWindow.cjs) and updates the tray whenever it resolves,
  // even if that's after the paste already happened — focus doesn't change because of the paste
  // itself, so the captured destination is accurate regardless of exactly when it resolves. This
  // is what makes it structurally impossible for detection latency to delay the actual paste.
  // Returns the promise so the "type" case below can await it — execSync fully blocks the event
  // loop for the whole typing duration, so an un-awaited call there wouldn't visibly resolve
  // until typing finishes (up to seconds later). Detection is fast enough (~10-20ms typically)
  // that awaiting it before typing starts is negligible next to typing's own baseline latency.
  function captureDestination() {
    return activeWindow.getActiveWindowInfo().then((info) => {
      lastPasteDestination = info;
      updateTrayMenu();
    });
  }

  // How long to leave our transcript as clipboard/selection owner before handing back whatever
  // was there before. X11/Wayland clipboard delivery is a live request/response with the owning
  // process (us) at the moment of paste, not a value copied into a shared buffer -- a busy target
  // (web apps especially, whose paste handler may not run until several other pending tasks
  // clear) can take a while to actually request the selection. Restoring too early revokes our
  // ownership before that request arrives, and the paste silently delivers nothing. 3s is
  // generous on purpose: the restore is scheduled below without blocking this handler's return,
  // so it costs nothing but a few seconds of "old clipboard is one paste away," and the
  // read-back check just below skips it if that's no longer safe anyway.
  const RESTORE_CLIPBOARD_DELAY_MS = 3000;

  // TEMPORARY DIAGNOSTICS (silent-paste-failure investigation), active only with debug_logging
  // on: asks the X server what the selections actually serve, via xclip -- i.e. from *outside*
  // our process, exercising the same owner-request path a pasting app uses, so a successful
  // read also proves we are answering selection requests at that moment. Logs only
  // lengths/match, never content.
  // Only possible because the ydotool call below is async: while awaiting xclip, our event
  // loop stays free to answer xclip's own selection request (execSync would deadlock here).
  async function xSelectionDiag(label) {
    if (!debugLogging || process.env.XDG_SESSION_TYPE === 'wayland') return;
    const read = async (sel) => {
      try {
        const { stdout } = await execFileAsync('xclip', ['-o', '-selection', sel, '-t', 'UTF8_STRING'], { timeout: 500 });
        return stdout;
      } catch { return null; } // unowned/empty selection, xclip missing, or owner didn't answer in time
    };
    const [prim, clip] = await Promise.all([read('primary'), read('clipboard')]);
    const fmt = (v) => v === null ? 'UNREADABLE' : (v === text ? `match(${v.length})` : `MISMATCH(len ${v.length})`);
    log('debug', `paste-diag ${label}: primary=${fmt(prim)} clipboard=${fmt(clip)}`);
  }

  async function doPaste() {
    const saved = saveClipboard();
    clipboard.writeText(text);
    clipboard.writeText(text, 'selection');
    await new Promise(resolve => setTimeout(resolve, 250));
    captureDestination();
    await xSelectionDiag('pre-key');
    const sinceHotkey = lastHotkeyAt ? Date.now() - lastHotkeyAt : -1;
    const t0 = Date.now();
    try {
      // execFile (async), not execSync: this keeps the main process' event loop free to service
      // the target app's clipboard-selection request, which we must answer as clipboard owner on
      // this same thread. Blocking here for the time ydotool takes to run risks stalling that
      // response right when it's needed most. Still awaited, so callers see the real outcome
      // and errors/timeouts are still caught below -- this isn't fire-and-forget.
      const { stderr } = await execFileAsync('ydotool', ['key', '--key-delay', '20', '42:1', '110:1', '110:0', '42:0'], { timeout: 5000, env: ydotool.env() });
      log('debug', `paste-diag key: ydotool ok in ${Date.now() - t0}ms, ${sinceHotkey}ms after hotkey${stderr && stderr.trim() ? `, stderr: ${stderr.trim()}` : ''}`);
    } catch (err) {
      log('error', `output-text paste key simulation failed: ${err.message}`);
    }
    // One more reading after the paste should have landed, to catch ownership being lost/replaced
    // in the window around the keystroke itself.
    setTimeout(() => { xSelectionDiag('post-key+500ms'); }, 500);
    // Scheduled rather than awaited so this handler's promise resolves immediately instead of
    // keeping the renderer's invoke() pending for RESTORE_CLIPBOARD_DELAY_MS. Skips the restore
    // if the clipboard no longer holds our transcript: that means the user (or another process,
    // e.g. a clipboard manager) has since taken ownership, and blindly restoring the old value
    // would clobber that instead of being a harmless no-op.
    setTimeout(() => {
      if (clipboard.readText() === text) {
        restoreClipboard(saved);
      }
    }, RESTORE_CLIPBOARD_DELAY_MS);
  }

  try {
    switch (method) {
      case "paste":
        await doPaste();
        break;
      case "type": {
        // Use a random temp filename to prevent symlink race attacks on a predictable path
        const tempFile = path.join(os.tmpdir(), `unhush-${crypto.randomBytes(8).toString('hex')}.txt`);
        try {
          fs.writeFileSync(tempFile, text);
          await new Promise(resolve => setTimeout(resolve, 250));
          await captureDestination();
          const timeout = Math.max(5000, text.length * 50);
          // Note: Previously we used a --delay 100 to give time for the OS focus to return to the target app; seems no longer needed (?)
          execSync(`ydotool type --key-delay 12 --file ${tempFile}`, { timeout, stdio: 'ignore', env: ydotool.env() });
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

// reasonKey identifies which independent cause this is (e.g. "config", "runtime", "warmup") —
// see WARNING_MESSAGES above. Setting/clearing one reason never affects any other.
ipcMain.on("set-formatter-warning", (_event, reasonKey, on) => {
  const had = formatterWarnings.has(reasonKey);
  if (on === had) return; // no-op, avoid redundant icon churn
  if (on) formatterWarnings.add(reasonKey); else formatterWarnings.delete(reasonKey);
  log(on ? "warn" : "info", `Formatter warning '${reasonKey}' ${on ? "raised" : "cleared"} (tray badge updated)`);
  updateTrayIcon();
  updateTrayMenu();
});

ipcMain.on("set-transcription-warning", (_event, reasonKey, on) => {
  const had = transcriptionWarnings.has(reasonKey);
  if (on === had) return; // no-op, avoid redundant icon churn
  if (on) transcriptionWarnings.add(reasonKey); else transcriptionWarnings.delete(reasonKey);
  log(on ? "warn" : "info", `Transcription warning '${reasonKey}' ${on ? "raised" : "cleared"} (tray badge updated)`);
  updateTrayIcon();
  updateTrayMenu();
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

// Which PulseAudio/PipeWire source "default" currently resolves to. The renderer can't
// tell on Linux — Chromium reports only a "Default" pseudo-device (no concrete label or
// groupId) and fires no devicechange event when the system default changes — so the
// keep-mic-warm reuse check asks us, to notice the user switched microphones while the
// previous one was held open.
ipcMain.handle("get-default-mic-source", () => {
  if (process.platform !== "linux") return Promise.resolve("");
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile("pactl", ["get-default-source"], (err, stdout) => {
      // pactl missing or failed — return unknown; the caller treats "" as "no change"
      resolve(err ? "" : stdout.trim());
    });
  });
});

ipcMain.on("set-recording-state", (event, state) => {
  setRecordingActive(state);
});

ipcMain.on("set-ducking-config", (event, config) => {
  audioDucking.setConfig(config);
});

ipcMain.handle("update-shortcut", async (event, shortcut) => {
  await registerShortcut(shortcut);
  return true;
});

ipcMain.handle("get-shortcut-mode", () => {
  if (!isWayland) return "native";
  return waylandShortcut.shortcutMode();
});

// Check the ydotool paste path at startup and, if something is broken, show the setup window.
// Skipped when output mode is 'clipboard', since ydotool isn't used in that case.
//
// The old version of this warned on a single fs.accessSync of /dev/uinput and latched a sentinel
// file *before* showing the dialog, so a genuinely broken install was hidden forever after one
// dismissal — and a package postinstall's asynchronous `udevadm trigger` could easily lose the
// race against an installer's "Launch" button and warn about a permission that was about to
// arrive. ydotool.preflight() retries, and diagnoses the daemon and the client binary too.
let setupWindow = null;
let lastSetupResult = null; // most recent preflight, so "don't show again" mutes what was on screen

function setupMuteFile() {
  return path.join(app.getPath("userData"), ".setup-dialog-muted");
}

function mutedProblems() {
  try {
    return new Set(JSON.parse(fs.readFileSync(setupMuteFile(), "utf8")));
  } catch (e) {
    // Pre-3.2 sentinel: the user dismissed the old uinput-only dialog, so honour that for uinput.
    if (fs.existsSync(path.join(app.getPath("userData"), ".uinput-warned"))) return new Set(["uinput"]);
    return new Set();
  }
}

async function checkOutputPath() {
  const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFilePath, "utf8")); } catch (e) {}
  if ((settings.outputMode || "paste") === "clipboard") return;

  const result = await ydotool.preflight();
  lastSetupResult = result;
  if (result.ok) return;

  // Only stay quiet if the user muted *these* problems; a new failure still deserves a warning.
  const muted = mutedProblems();
  if (result.problems.every((p) => muted.has(p.code))) {
    log("info", `setup problems suppressed by user: ${result.problems.map((p) => p.code).join(", ")}`);
    return;
  }
  showSetupWindow(result);
}

function showSetupWindow(result) {
  if (setupWindow) {
    setupWindow.webContents.send("setup-result", result);
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 640,
    height: 620,
    minWidth: 460,
    minHeight: 320,
    resizable: true,      // the problem list varies in length, so let it be resized
    // It's a dialog, not an app window. `parent` is what actually does the work on Linux: it
    // sets WM_TRANSIENT_FOR, and window managers then drop the minimise/maximise buttons.
    // The minimizable/maximizable flags alone are documented as inconsistent on Linux.
    parent: mainWindow || undefined,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: appIcon,
    title: "Unhush Setup",
  });
  setupWindow.on("closed", () => { setupWindow = null; });
  setupWindow.webContents.on("did-finish-load", () => {
    setupWindow.webContents.send("setup-result", result);
  });
  setupWindow.loadFile(path.join(__dirname, "setup-dialog.html"));
}

ipcMain.handle("ydotool-preflight", async () => {
  lastSetupResult = await ydotool.preflight();
  return lastSetupResult;
});

ipcMain.handle("open-settings-window", (event, tab) => {
  createSettingsWindow(tab || "usability");
  return true;
});

ipcMain.on("close-setup-dialog", () => {
  if (setupWindow) setupWindow.close();
});

// Remember which problems the user chose not to be warned about again, by code rather than as a
// blanket flag, so an unrelated failure later still surfaces. Records what was actually on screen
// when they ticked the box, rather than re-running the checks and possibly storing something else.
ipcMain.on("set-setup-dialog-muted", (event, muted) => {
  try {
    if (!muted) { fs.unlinkSync(setupMuteFile()); return; }
    const codes = (lastSetupResult ? lastSetupResult.problems : []).map((p) => p.code);
    fs.writeFileSync(setupMuteFile(), JSON.stringify(codes));
    log("info", `setup warnings muted for: ${codes.join(", ") || "(none)"}`);
  } catch (e) {
    log("warn", `could not update setup-dialog mute state: ${e.message}`);
  }
});

// Single-instance toggle: on Wayland without portal support (GNOME < 48, wlroots compositors),
// the global hotkey is a manual desktop env. keyboard shortcut that simply re-launches Unhush.
// The new instance fails to acquire the lock, logs the toggle, and quits immediately.
// The running instance receives "second-instance" and toggles recording.
// On X11 and portal-capable Wayland (KDE, GNOME 48+) this path is not used for the hotkey,
// but re-running Unhush manually will still toggle recording as a convenient fallback.
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
    logFile = path.join(logDir, 'unhush.log');

    try {
      const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
      const cfg = JSON.parse(fs.readFileSync(settingsFilePath, "utf8"));
      debugLogging = cfg.debug_logging === true || cfg.debug_logging === "true";
    } catch (e) {} // missing/invalid settings.json — debugLogging stays false

    Menu.setApplicationMenu(null);
    const offsetFromBottom = 45; /* window bottom from desktop bottom) */
    createWindow(offsetFromBottom);
    createTray();
    checkOutputPath();

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
      // New style: save to /tmp/unhush-debug/{subdir}/{filename}
      // Validate that both subdir and filename stay within the debug root (prevent path traversal)
      const BASE_DEBUG_DIR = "/tmp/unhush-debug";
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
      const debugDir = "/tmp/unhush-debug";
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
  audioDucking.restoreSyncForQuit();
  globalShortcut.unregisterAll();
  // Our ydotoold must not outlive us — it holds an open /dev/uinput virtual keyboard.
  // No-op if we adopted someone else's daemon rather than starting one.
  ydotool.stopDaemon();
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
