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
const commandFifo = require("./commandFifo.cjs");
const audioDucking = require("./audioDucking.cjs");
const activeWindow = require("./activeWindow.cjs");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Defined here because the re-exec guard below needs it too, and that runs before initLogging().
//
// Owner-only, both logfile and log.
// To maintain privacy, nothing here logs dictated text (although debug_audio does, if opted in)
function logFilePath() {
  const logDir = app.getPath("logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = path.join(logDir, "unhush.log");
  try {
    // The mode arguments above only apply at creation, so an install that predates this keeps
    // whatever the umask gave it. Both are ours alone, so narrow them in place.
    if ((fs.statSync(logDir).mode & 0o077) !== 0) fs.chmodSync(logDir, 0o700);
    fs.closeSync(fs.openSync(file, "a", 0o600));
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  } catch (e) { /* the caller's own open will report anything that really matters */ }
  return file;
}

// Where the re-exec'd child's stdout/stderr should go: the log file, always. Chromium writes its
// own diagnostics from C++ straight to fd 2 -- GPU failures, "Failed to connect to Wayland
// display", crash output -- so none of it passes through log() and none of it would otherwise
// land in our file. Inheriting the terminal instead was worse than it sounds: the parent has
// already exited and handed the prompt back, so the child's output arrives *after* the prompt,
// interleaved with whatever the user typed next, for as long as the app runs. To watch that
// stream live rather than in the log, launch with --ozone-platform=x11 yourself -- the guard
// below then leaves the process alone and its output stays attached to the terminal.
function childStdio() {
  try {
    const fd = fs.openSync(logFilePath(), "a", 0o600);
    return ["ignore", fd, fd];
  } catch (e) {
    // Nowhere to put it. Discard rather than inherit: a terminal the user has already got back
    // is not a log, and this only happens when the log directory itself is unusable.
    return "ignore";
  }
}

// --- Run under XWayland on Wayland sessions ---------------------------------------------------
// Electron 38.2+ is a native Wayland client by default. Wayland forbids placing its own window
// (the recording pill lands centre-screen), keeping it above
// other windows, and owning the clipboard while unfocused -- wl_data_device.set_selection needs a
// serial from a recent input event, and the pill is focusable:false, so transcripts reached the
// clipboard only sporadically. All three work under XWayland exactly as on an X11 session, and we
// already sidestep Wayland's input model anyway by injecting keystrokes through /dev/uinput.
//
// Chromium picks its ozone platform long before this script runs, so appendSwitch() is far too
// late -- the flag must be on the real command line, which means re-execing ourselves. (Putting it
// in the packaged .desktop Exec line instead would avoid that, but electron-builder refuses to
// override Exec: "Please specify executable name as linux.executableName instead".) One mechanism
// covering every launch style is the simpler outcome anyway; it costs one extra Electron init,
// only on Wayland, and only up to this point -- no window is created before we exit.
//
// This runs before requestSingleInstanceLock() below, so the process about to die never takes it.
if (
  process.env.XDG_SESSION_TYPE === "wayland" &&
  // The opt-out is disabled, not removed. Native Wayland cannot deliver a reliable clipboard on
  // GNOME: setting a selection while unfocused needs ext-data-control-v1 (the protocol wl-copy
  // uses), Mutter implements neither it nor its wlr- predecessor and has said it won't, and
  // wl-clipboard's only fallback there is to briefly take focus -- which would break the very
  // paste we are setting up. A mode whose core function can't work on half the Linux desktop
  // isn't one to offer. Re-enable this line if that ever changes.
  // process.env.UNHUSH_NATIVE_WAYLAND !== "1" &&
  !process.env.UNHUSH_REEXEC && // belt-and-braces against an exec loop
  // Someone who passes the flag themselves is still honoured -- unsupported, but not fought.
  !process.argv.some((a) => a.startsWith("--ozone-platform"))
) {
  const { spawn } = require("child_process");
  spawn(process.execPath, ["--ozone-platform=x11", ...process.argv.slice(1)], {
    detached: true,
    stdio: childStdio(),
    env: { ...process.env, UNHUSH_REEXEC: "1" },
  }).unref();
  // The parent exits the instant the child is spawned, so from a terminal `unhush` looks like it
  // failed: the prompt comes straight back before the child has drawn anything. Say what actually
  // happened -- but only when someone is there to read it. With no TTY this is nobody's business:
  // the child's own startup banner records the same facts in the log.
  if (process.stderr.isTTY) {
    process.stderr.write(
      `Unhush ${app.getVersion()}: Wayland session — relaunching under XWayland.\n` +
      `Starting in the background; look for the tray icon.\n`
    );
  }
  process.exit(0);
}

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
const startedAt = Date.now();
function log(level, message) {
  if (level === "debug" && !debugLogging) return;
  if (!logFile) {
    // shouldn't happen — initLogging() runs at module load, before anything calls log()
    console.error(`[pre-init log] ${level.toUpperCase()}: ${message}`);
    return;
  }
  const now = new Date();
  const localISO = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
  const line = `[${localISO}] ${level.toUpperCase()}: ${message}\n`;
  fs.appendFileSync(logFile, line);
  if (isDev) console.log(line.trimEnd());
}

// Opens the log at module load rather than in whenReady(), so everything from the very first
// module initialisation onwards is recorded — the second-instance path and any startup failure
// both happen before "ready" and used to vanish into console.error. app.getPath() and
// app.getVersion() are documented as usable before "ready" (verified: the logs path is
// identical before and after).
function initLogging() {
  try {
    logFile = logFilePath();
  } catch (e) {
    // Running at module load means a throw here would take the whole app down over a log file.
    // Leave logFile null instead: log() then falls back to console.
    console.error(`could not open log file: ${e.message}`);
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));
    debugLogging = cfg.debug_logging === true || cfg.debug_logging === "true";
  } catch (e) {} // missing/invalid settings.json — debugLogging stays false
}

function uptimeString(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : m ? `${m}m${s % 60}s` : `${s}s`;
}

// Logged once per real launch (not for the second-instance hotkey relaunches, which would
// otherwise banner the log on every dictation toggle under the Wayland fallback).
function logStartup() {
  log("info", `=== Unhush ${app.getVersion()} starting: electron ${process.versions.electron}, ` +
    `node ${process.versions.node}, pid ${process.pid}, ${isDev ? "dev" : "packaged"} ===`);
  log("info", `platform: ${os.type()} ${os.release()} ${process.arch}, ` +
    `session=${process.env.XDG_SESSION_TYPE || "?"}, desktop=${process.env.XDG_CURRENT_DESKTOP || "?"}, ` +
    `ozone=${waylandShortcut.displayBackend()}, logs=${logFile}`);
}

initLogging();
// ydotool takes the userData path rather than requiring electron itself — it's its only reason
// to, and without it it's testable as plain node. waylandShortcut needs nothing from electron.
waylandShortcut.init(log);
ydotool.init(log, app.getPath("userData"));
commandFifo.init(log);
audioDucking.init(log, app.getName());
activeWindow.init(log);

app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("enable-accelerated-2d-canvas");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

// Session-type and compositor knowledge now lives entirely in waylandShortcut.cjs, which is the
// only place that acts on it.
//
// No GlobalShortcutsPortal switch here any more. We force XWayland, where Chromium builds an X11
// listener and never touches the portal; and on a forced native-Wayland run the switch would
// still be pointless, since Chromium enables kGlobalShortcutsPortal by default and Electron
// adds GlobalShortcutsPortalPreferredTrigger itself on Linux. It was also appended too late to
// affect the feature list, which is built before this script runs.

let shortcutRegistered = false;

async function registerShortcut(shortcut) {
  // On Wayland the portal owns the binding, and it honors a "preferred trigger" on the first bind
  // only -- so this call exists to hand the user's stored accelerator to that first bind, and does
  // nothing afterwards. Changing the key from here is impossible by design; Settings offers the
  // desktop's own editor instead for this purpose (waylandShortcut.configure()).
  if (waylandShortcut.usesPortal()) {
    await waylandShortcut.startPortal(
      shortcut,
      () => {
        log("info", "portal shortcut fired");
        lastHotkeyAt = Date.now();
        toggleRecording();
      },
      // The tray menu names the key, so it has to follow the desktop's editor too.
      () => updateTrayMenu(),
    );
    currentShortcut = shortcut;
    updateTrayMenu();
    return;
  }

  if (shortcut === currentShortcut && shortcutRegistered) return;

  globalShortcut.unregisterAll();
  shortcutRegistered = false;

  try {
    const ok = await globalShortcut.register(shortcut, () => {
      log("debug", `global shortcut fired: ${shortcut}`);
      lastHotkeyAt = Date.now();
      toggleRecording();
    });
    shortcutRegistered = ok !== false;
  } catch (e) {}
  log("info", `global shortcut ${shortcutRegistered ? "registered" : "NOT registered"}: ${shortcut}`);

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

// What to call the hotkey in the tray menu. Ours to name only while we hold the grab: on the
// portal path the desktop decides, and in manual mode there may be no key bound at all.
function shortcutLabel() {
  switch (waylandShortcut.shortcutMode()) {
    case "portal": return waylandShortcut.shortcutInfo().trigger || "";
    case "manual": return "";
    default: return currentShortcut;
  }
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
      // On the portal path the live key is whatever the desktop says it is -- the user may have
      // added their own trigger and unchecked ours, and an empty description means there is no trigger.
      label: `Toggle Recording${shortcutLabel() ? ` (${shortcutLabel()})` : ""}`,
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
  // The only way a delivered hotkey/fifo command can still do nothing: say so rather than no-op
  // silently, since from outside that is indistinguishable from the trigger never arriving.
  if (!mainWindow) log("warn", "toggleRecording: no main window, ignoring");
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

// outputMethod, when given, is a mode for Settings to select as it opens -- the setup dialog's
// "Use Clipboard mode instead" uses it. It travels in the query string rather than as an IPC
// message because a freshly created window would still be mounting React when the send arrived;
// the already-open branch below has no such race and uses an event, exactly as `tab` does.
function createSettingsWindow(tab = null, outputMethod = null) {
  if (settingsWindow) {
    if (tab) settingsWindow.webContents.send("navigate-tab", tab);
    if (outputMethod) settingsWindow.webContents.send("set-output-method-ui-setting", outputMethod);
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

  const query = {};
  if (tab) query.tab = tab;
  if (outputMethod) query.output = outputMethod;
  const search = new URLSearchParams(query).toString();

  if (isDev) {
    settingsWindow.loadURL(`http://localhost:5173/settings.html${search ? `?${search}` : ""}`);
  } else {
    settingsWindow.loadFile(path.join(__dirname, "../dist/settings.html"), { query });
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
        // The dictated text is written to disk, because `ydotool type` needs to read it from a file.
        // Only one ever exists at a time and it is unlinked in the finally below. It is written
        // into XDG_RUNTIME_DIR (0700, tmpfs, cleared at logout -- if it exists) rather than /tmp.
        // Random name also guards against symlink races, 0600 in case the fallback puts us in /tmp after all.
        const tempFile = path.join(commandFifo.runtimeDir(), `unhush-${crypto.randomBytes(8).toString('hex')}.txt`);
        try {
          fs.writeFileSync(tempFile, text, { mode: 0o600 });
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

// The renderer's output method, reported as it mounts and whenever the user changes it in Settings.
// Only the setup check needs it -- output-text carries the method with each request.
let reportOutputMethod;
const outputMethodKnown = new Promise((resolve) => { reportOutputMethod = resolve; });
// Single place that records the mode, so no caller can update one half of it and not the other.
// Also keeps the setup window's Re-check honest if the user switches mode while it is open.
function noteOutputMethod(method) {
  reportOutputMethod(method);
  setupIncludesYdotool = method !== "clipboard";
}
ipcMain.on("set-output-method", (event, method) => noteOutputMethod(method));

ipcMain.handle("update-shortcut", async (event, shortcut) => {
  await registerShortcut(shortcut);
  return true;
});

// Reports mode "native" on X11, where globalShortcut grabs the key itself, "portal" where the
// desktop holds the binding for us, and "manual" when the user has to bind it. Awaits the first
// bind attempt so Settings never renders a mode that's about to change under it. The fifo command
// comes back in every mode, since it works everywhere and can bind keys the dropdown doesn't list.
ipcMain.handle("get-shortcut-info", async () => {
  await waylandShortcut.settled();
  // Ask the portal what the key is *now*: the user may have added their own trigger, or unchecked
  // ours, since the bind at startup. One round trip, and only when a settings window opens.
  await waylandShortcut.refresh();
  return waylandShortcut.shortcutInfo();
});

// The only way to change a portal-bound key: the desktop's own editor, focused on our entry.
ipcMain.handle("configure-shortcut", () => waylandShortcut.configure());

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

// The setup window shows one card per problem. The ydotool paste path and the global shortcut are
// independent concerns, so they're gathered here rather than either module knowing about the other.
let setupIncludesYdotool = true;

async function setupPreflight() {
  const problems = setupIncludesYdotool ? (await ydotool.preflight()).problems : [];
  // Wait for the first portal bind to settle before deciding: on a Wayland first run that means
  // waiting out the desktop's consent dialog, and telling the user to bind a key by hand while
  // that dialog is on screen would be exactly wrong. Already resolved on X11.
  await waylandShortcut.settled();
  // Needed whatever the output mode, unlike the ydotool checks. Returns null unless the user
  // really does have to bind the key themselves.
  const shortcut = waylandShortcut.shortcutProblem();
  if (shortcut) problems.push(shortcut);
  return { ok: problems.length === 0, problems };
}

async function checkOutputPath() {
  const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFilePath, "utf8")); } catch (e) {}
  // The renderer owns this setting, in localStorage, so wait to be told rather than guess.
  // Don't nag a Clipboard-mode user about ydotool. The renderer reports it as it mounts
  // (see RecordingBar.tsx); the timeout covers a renderer that never gets there, and
  // settings.json is the last resort -- its keys are the localStorage names
  // minus the `unhush_` prefix (see the injection in createWindow), so it is `output_method`.
  const { method, source } = await Promise.race([
    outputMethodKnown.then((m) => ({ method: m, source: "renderer" })),
    new Promise((resolve) => setTimeout(() => resolve(settings.output_method
      ? { method: settings.output_method, source: "settings.json" }
      : { method: "paste", source: "default" }), 3000).unref?.()),
  ]);
  noteOutputMethod(method);
  // Name the source as well as the answer for better clarity
  log("debug", `setup check: output method ${method} (${source}), ydotool checks ${setupIncludesYdotool ? "included" : "skipped"}`);

  const result = await setupPreflight();
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
  lastSetupResult = await setupPreflight();
  return lastSetupResult;
});

ipcMain.handle("open-settings-window", (event, tab, outputMethod) => {
  // Record the requested mode now rather than waiting for Settings to mount and report it back:
  // the setup dialog re-checks as soon as this resolves, and would otherwise still be told the
  // ydotool problems it just opted out of. A mounting renderer re-reports the truth regardless.
  if (outputMethod) noteOutputMethod(outputMethod);
  createSettingsWindow(tab || "usability", outputMethod || null);
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
    fs.writeFileSync(setupMuteFile(), JSON.stringify(codes), { mode: 0o600 });
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

  logStartup();

  app.whenReady().then(() => {
    log("info", `app ready after ${Date.now() - startedAt}ms`);
    Menu.setApplicationMenu(null);
    const offsetFromBottom = 45; /* window bottom from desktop bottom) */
    createWindow(offsetFromBottom);
    createTray();
    checkOutputPath();
    commandFifo.start({ toggle: () => { lastHotkeyAt = Date.now(); toggleRecording(); } });

    // The renderer normally supplies the accelerator (it holds the stored setting) by calling
    // update-shortcut as it mounts, and that first call is what binds the portal shortcut. If the
    // renderer never gets there -- a crash, a very slow first paint -- the hotkey would simply
    // never exist, so bind the default rather than let the UI's health decide. Idempotent: whoever
    // arrives first wins, and the portal honours a preferred trigger on the first bind only anyway.
    setTimeout(() => {
      void registerShortcut(currentShortcut);
    }, 3000).unref?.();

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

// Under userData (~/.config/unhush/debug), rather than a publicly accessible location like /tmp,
// since this holds recordings of the user's voice and the transcripts made from them.
//
// $XDG_STATE_HOME would be the spec-correct home for state like this, but Electron already puts
// userData -- settings, LevelDB, caches and the log -- under the config directory on Linux, and
// splitting one directory out of that would only mean two places to find, document and delete.
function debugAudioDir() {
  return path.join(app.getPath("userData"), "debug");
}

ipcMain.handle("save-debug-audio", async (event, arrayBuffer, mimeType, subdir, filename) => {
  try {
    let extension, filePath;
    const BASE_DEBUG_DIR = debugAudioDir();
    if (subdir && filename) {
      // Validate that both subdir and filename stay within the debug root (prevent path traversal)
      const debugDir = path.resolve(path.join(BASE_DEBUG_DIR, subdir));
      if (!debugDir.startsWith(BASE_DEBUG_DIR + path.sep) && debugDir !== BASE_DEBUG_DIR)
        throw new Error("Path traversal attempt in subdir");
      fs.mkdirSync(debugDir, { recursive: true, mode: 0o700 });
      filePath = path.join(debugDir, path.basename(filename)); // basename prevents traversal via filename
    } else {
      // Legacy style: auto-generate filename from timestamp
      extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
      const now = new Date();
      const timestamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1).replace(/[:.]/g, "-");
      fs.mkdirSync(BASE_DEBUG_DIR, { recursive: true, mode: 0o700 });
      filePath = path.join(BASE_DEBUG_DIR, `recording-${timestamp}.${extension}`);
    }
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer), { mode: 0o600 });
    return filePath;
  } catch (err) {
    console.error("Failed to save debug audio:", err);
    return null;
  }
});

app.on("window-all-closed", () => {
  // Keep app running in tray
});

// Teardown steps are independent: a throw in one must not skip the rest. Quitting mid-recording
// was doing exactly that -- the shutdown line appeared but the command fifo survived, and on a
// machine where we spawned ydotoold it would have been orphaned holding a uinput keyboard. The
// label tells us which step failed rather than leaving it to be inferred.
function tryTeardown(label, fn) {
  const t0 = Date.now();
  try { fn(); } catch (e) { log("warn", `teardown step "${label}" failed: ${e.message}`); }
  log("debug", `teardown: ${label} (${Date.now() - t0}ms)`);
}

app.on("will-quit", () => {
  // First thing, so the shutdown is on record even if a teardown step below throws.
  // Skipped for the second instance, which quits immediately and never really started.
  if (gotTheLock) log("info", `=== Unhush shutting down after ${uptimeString(Date.now() - startedAt)} ===`);
  tryTeardown("audio ducking", () => audioDucking.restoreSyncForQuit());
  tryTeardown("global shortcuts", () => globalShortcut.unregisterAll());
  // Closes the D-Bus connection and cancels any pending rebind, so quitting can't be chased by a
  // retry. The binding itself survives in the desktop's settings -- the portal has no unbind.
  tryTeardown("portal shortcuts", () => waylandShortcut.stopPortal());
  // Our ydotoold must not outlive us — it holds an open /dev/uinput virtual keyboard.
  // No-op if we adopted someone else's daemon rather than starting one.
  tryTeardown("ydotoold", () => ydotool.stopDaemon());
  // Leaving the pipe behind would make `unhush-toggle` block on a fifo with no reader.
  tryTeardown("command fifo", () => commandFifo.stop());
  log("debug", "teardown: complete");
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

// Chromium's browser process installs its own SIGINT/SIGTERM handling and shuts down cleanly
// through "will-quit" on both, ahead of node's listeners -- measured, by sending each signal to
// the main pid alone and finding the shutdown line present but the one below absent. These stay
// only as a fallback for a signal arriving before that machinery is up (e.g. during module
// load), and the log line is how we would find out that ever happens.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("info", `received ${sig} — quitting`);
    app.quit();
  });
}

app.on("before-quit", () => {
  if (tray) {
    tray.destroy();
  }
});
