// Ducks (lowers) other applications' PulseAudio/PipeWire playback volume while recording,
// so ambient music/notifications don't compete with the mic and don't get picked up.
// Our own beeps must stay untouched — see isOwnStream().
//
// Linux-only mechanism (via pactl, which works against both PulseAudio and PipeWire through
// pipewire-pulse). Every entry point below no-ops on other platforms so a future macOS/Windows
// backend can be added by extending the checks, without touching callers in main.cjs.

const { execFile, execFileSync, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const execFileAsync = promisify(execFile);

// A coarse, fast ramp is audibly "steppy" (each jump is individually perceptible). Ducking
// doesn't gate recording start (duck() is fired-and-forgotten — see main.cjs), so there's no
// cost to favoring smoothness over speed here.
const RAMP_STEPS = 8;
const RAMP_STEP_MS = 50; // 400ms total ramp
const NEW_STREAM_RAMP_STEPS = 8;
const NEW_STREAM_RAMP_STEP_MS = 30; // 240ms — a newly-appeared stream catches up a bit faster
const VOLUME_MATCH_EPSILON = 700; // ~1% of the 0-65536 raw volume range

const isLinux = process.platform === "linux";

let log = () => {};
let ownPid = process.pid;
let ownName = "";

let amount = 0; // 0-100; 0 = disabled
let pactlUsable = true; // flips false permanently if pactl binary is missing
let jsonModeUsable = null; // null = untested, true/false once we know (pactl < 16 lacks -f json)

// sink-input id -> { channels: number[] } of ORIGINAL raw (0-65536) per-channel volumes.
// Entries live here until a restore() fully completes, so a duck() that arrives mid-restore
// reuses true originals instead of capturing a half-restored volume as "original".
let savedStreams = new Map();
let currentFactor = 1.0; // 1.0 = untouched, 0.0 = fully muted
let rampToken = null; // identity token; a new duck()/restore() invalidates any ramp in flight
let subscribeChild = null; // `pactl subscribe` child, watching for streams that start mid-duck

function init(logFn, appName) {
  log = logFn;
  ownName = (appName || "").toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- parsing -----------------------------------------------------------------------------

function parseJsonSinkInputs(stdout) {
  const data = JSON.parse(stdout);
  return data.map((entry) => ({
    id: String(entry.index),
    channels: Object.values(entry.volume || {}).map((c) => c.value),
    props: entry.properties || {},
  }));
}

// Fallback for pactl < 16, which lacks `-f json`. Parses the classic
// "Sink Input #N / Volume: ... / Properties: ..." block format.
function parseTextSinkInputs(stdout) {
  const blocks = stdout.split(/\n(?=Sink Input #)/);
  const result = [];
  for (const block of blocks) {
    const idMatch = block.match(/^Sink Input #(\d+)/);
    if (!idMatch) continue;
    const volumeLine = block.match(/^\tVolume: (.+)$/m);
    const channels = volumeLine
      ? [...volumeLine[1].matchAll(/[\w-]+:\s*(\d+)\s*\//g)].map((m) => parseInt(m[1], 10))
      : [];
    const props = {};
    const propsSection = block.split(/^\tProperties:\n/m)[1];
    if (propsSection) {
      for (const m of propsSection.matchAll(/^\t\t([\w.]+) = "(.*)"$/gm)) {
        props[m[1]] = m[2];
      }
    }
    result.push({ id: idMatch[1], channels, props });
  }
  return result;
}

async function listSinkInputs() {
  if (!pactlUsable) return [];
  if (jsonModeUsable !== false) {
    try {
      const { stdout } = await execFileAsync("pactl", ["-f", "json", "list", "sink-inputs"]);
      jsonModeUsable = true;
      return parseJsonSinkInputs(stdout);
    } catch (err) {
      if (err.code === "ENOENT") {
        pactlUsable = false;
        log("warn", "audioDucking: pactl not found — disabling audio ducking");
        return [];
      }
      jsonModeUsable = false;
      log("info", "audioDucking: pactl JSON output unsupported, falling back to text parsing");
    }
  }
  try {
    const { stdout } = await execFileAsync("pactl", ["list", "sink-inputs"]);
    return parseTextSinkInputs(stdout);
  } catch (err) {
    if (err.code === "ENOENT") {
      pactlUsable = false;
      log("warn", "audioDucking: pactl not found — disabling audio ducking");
    } else {
      log("warn", `audioDucking: failed to list sink-inputs: ${err.message}`);
    }
    return [];
  }
}

// --- own-stream exclusion ------------------------------------------------------------------
// Chromium plays our beeps through its own "AudioService" utility process, which is a *child*
// of Electron's main process — not the main process itself, and not the renderer. So PID
// equality with process.pid isn't enough; we walk the parent chain instead. Verified live: for
// this app, application.process.id is the AudioService PID, one PPid hop below our main PID.
// application.name (== app.getName(), lowercased) is checked too, as a belt-and-braces fallback.

function readParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2); // comm can contain spaces/parens
    const fields = afterComm.split(" ");
    const ppid = parseInt(fields[1], 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch (e) {
    return null;
  }
}

function isDescendantOf(pid, ancestorPid, readParent, maxHops = 10) {
  let current = pid;
  for (let i = 0; i < maxHops; i++) {
    if (current === ancestorPid) return true;
    const parent = readParent(current);
    if (parent === null || parent <= 1) return false;
    current = parent;
  }
  return false;
}

function isOwnStream(props, expectedPid, expectedName, readParent = readParentPid) {
  const pidStr = props["application.process.id"];
  if (pidStr) {
    const pid = parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isDescendantOf(pid, expectedPid, readParent)) return true;
  }
  const name = (props["application.name"] || "").toLowerCase();
  return !!expectedName && name === expectedName;
}

// --- volume math (pure, for tests) ----------------------------------------------------------

function computeRampSteps(fromFactor, toFactor, steps) {
  const out = [];
  for (let k = 1; k <= steps; k++) {
    out.push(fromFactor + (toFactor - fromFactor) * (k / steps));
  }
  return out;
}

function scaledChannelVolumes(originalChannels, factor) {
  return originalChannels.map((v) => Math.round(v * factor));
}

// --- applying volumes ------------------------------------------------------------------------

async function setSinkInputVolume(id, values) {
  try {
    await execFileAsync("pactl", ["set-sink-input-volume", id, ...values.map(String)]);
    return true;
  } catch (err) {
    return false; // stream likely closed mid-duck — caller drops it opportunistically
  }
}

function setSinkInputVolumeSync(id, values) {
  try {
    execFileSync("pactl", ["set-sink-input-volume", id, ...values.map(String)], { stdio: "ignore" });
  } catch (e) {
    // best-effort during quit
  }
}

async function runRamp(toFactor) {
  const token = {};
  rampToken = token;
  const steps = computeRampSteps(currentFactor, toFactor, RAMP_STEPS);
  for (const f of steps) {
    if (rampToken !== token) return; // superseded by a newer duck()/restore()
    const stepStart = Date.now();
    await Promise.allSettled(
      [...savedStreams].map(([id, saved]) => setSinkInputVolume(id, scaledChannelVolumes(saved.channels, f))),
    );
    if (rampToken !== token) return;
    currentFactor = f;
    const elapsed = Date.now() - stepStart;
    if (elapsed < RAMP_STEP_MS) await sleep(RAMP_STEP_MS - elapsed);
  }
}

// --- new-stream watcher ------------------------------------------------------------------

function startSubscribeWatcher() {
  if (subscribeChild || !isLinux) return;
  try {
    subscribeChild = spawn("pactl", ["subscribe"]);
  } catch (e) {
    subscribeChild = null;
    return;
  }
  let buf = "";
  subscribeChild.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep the trailing partial line for next time
    for (const line of lines) {
      const m = line.match(/Event 'new' on sink-input #(\d+)/);
      if (m) handleNewSinkInput(m[1]);
    }
  });
  subscribeChild.on("error", () => { subscribeChild = null; });
  subscribeChild.on("exit", () => { subscribeChild = null; });
}

function stopSubscribeWatcher() {
  if (subscribeChild) {
    subscribeChild.kill();
    subscribeChild = null;
  }
}

async function handleNewSinkInput(id) {
  if (amount <= 0 || savedStreams.has(id)) return;
  // Query immediately — any delay here is an audible window where the new stream plays at
  // full, un-ducked volume. PipeWire only announces a node once it's fully initialized, so
  // it should already be queryable; the one retry covers the rare case where it isn't yet.
  let s = (await listSinkInputs()).find((x) => x.id === id);
  if (!s) {
    await sleep(30);
    s = (await listSinkInputs()).find((x) => x.id === id);
  }
  if (!s || isOwnStream(s.props, ownPid, ownName)) return;
  savedStreams.set(id, { channels: s.channels });
  const target = 1 - amount / 100;
  const steps = computeRampSteps(1.0, target, NEW_STREAM_RAMP_STEPS);
  for (const f of steps) {
    if (!savedStreams.has(id)) return; // restored/dropped while we were mid-ramp
    await setSinkInputVolume(id, scaledChannelVolumes(s.channels, f));
    await sleep(NEW_STREAM_RAMP_STEP_MS);
  }
}

// --- public API ----------------------------------------------------------------------------

async function duck() {
  if (!isLinux || amount <= 0) return;
  const streams = await listSinkInputs();
  let ownCount = 0;
  for (const s of streams) {
    if (isOwnStream(s.props, ownPid, ownName)) { ownCount++; continue; }
    if (!savedStreams.has(s.id)) savedStreams.set(s.id, { channels: s.channels });
  }
  if (savedStreams.size === 0) return;
  log("debug", `audioDucking: ducking ${savedStreams.size} stream(s), excluded ${ownCount} own stream(s)`);
  startSubscribeWatcher();
  await runRamp(1 - amount / 100);
}

async function restore() {
  if (savedStreams.size === 0) { stopSubscribeWatcher(); return; }
  // Drop any stream the user manually adjusted mid-duck, or that closed mid-duck — leave
  // the former alone, and there's nothing to restore for the latter.
  const current = await listSinkInputs();
  const currentById = new Map(current.map((s) => [s.id, s]));
  for (const [id, saved] of savedStreams) {
    const live = currentById.get(id);
    if (!live) { savedStreams.delete(id); continue; }
    const expected = scaledChannelVolumes(saved.channels, currentFactor);
    const changed =
      live.channels.length !== expected.length ||
      live.channels.some((v, i) => Math.abs(v - expected[i]) > VOLUME_MATCH_EPSILON);
    if (changed) savedStreams.delete(id);
  }
  if (savedStreams.size === 0) { stopSubscribeWatcher(); currentFactor = 1.0; return; }
  await runRamp(1.0);
  savedStreams.clear();
  currentFactor = 1.0;
  stopSubscribeWatcher();
}

function setConfig(config) {
  const newAmount = Math.max(0, Math.min(100, Number(config && config.amount) || 0));
  const wasEnabled = amount > 0;
  amount = newAmount;
  if (wasEnabled && amount <= 0 && savedStreams.size > 0) restore();
}

// Synchronous, no ramp — for app "will-quit" only. A hard crash (SIGKILL) can't be covered;
// the user would need to re-adjust volume manually in that case.
function restoreSyncForQuit() {
  if (!isLinux || savedStreams.size === 0) return;
  for (const [id, saved] of savedStreams) {
    setSinkInputVolumeSync(id, saved.channels);
  }
  savedStreams.clear();
  currentFactor = 1.0;
  stopSubscribeWatcher();
}

module.exports = {
  init,
  setConfig,
  duck,
  restore,
  restoreSyncForQuit,
  _internal: {
    parseJsonSinkInputs,
    parseTextSinkInputs,
    computeRampSteps,
    scaledChannelVolumes,
    isOwnStream,
    readParentPid,
  },
};
