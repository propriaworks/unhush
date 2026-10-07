// Under Niri, the recording bar needs a window rule in the user's niri config, and this module
// checks for it and supplies the setup-window card that asks for it.
//
// Why: everywhere else the bar is created once and stays mapped, transparent and click-through
// between recordings, which works because a real X11 window manager (including KWin and Mutter
// for XWayland) treats a _NET_WM_WINDOW_TYPE_NOTIFICATION window as an unmanaged overlay. Niri's
// XWayland is xwayland-satellite, which turns that window into an ordinary xdg_toplevel (its role
// heuristic only makes popups of override-redirect, menu, tooltip, DND and combo windows), so Niri
// tiles or floats it like any app, draws its focus ring around nothing, and keeps it on one
// workspace -- Niri has no sticky windows (niri-wm/niri#932). So under Niri, main.cjs hides the
// bar between recordings, and each recording opens a fresh Niri window on the current workspace.
//
// What code cannot do is stop Niri from focusing that window as it opens: only a window rule can
// (open-focused false). Without it the bar takes keyboard focus during the recording, and the
// paste races Niri handing focus back. The fixed-height bar opens floating even without the rule
// (Niri floats fixed-height windows), but at screen centre; the rule puts it at bottom centre.
//
// Niri's IPC cannot list window rules, and parsing the user's config (with its includes) would be
// guesswork, so the check observes instead: show the empty, transparent bar for a moment, ask Niri
// whether it opened focused, then hide it. With the rule in place nothing visible happens.
//
// No `electron` import here (mirrors the other setup-card modules): main.cjs passes in callbacks
// to show and hide the bar.

const { request } = require("./niriIpc.cjs");

const CODE = "niri-window-rule";
// index.html's <title>, which Electron sets as the window title. Matched by title alone: the app
// id satellite reports comes from Electron's WM_CLASS, which we don't control or document.
const BAR_TITLE = "Unhush - Voice Input";
const RULE = [
  "window-rule {",
  `    match title="^${BAR_TITLE}$"`,
  "    open-floating true",
  "    open-focused false",
  // 45 matches the bar's offset from the bottom elsewhere (main.cjs's offsetFromBottom).
  "    default-floating-position x=0 y=45 relative-to=\"bottom\"",
  "    focus-ring { off; }",
  "    border { off; }",
  "    shadow { off; }",
  "}",
];

const FIND_TIMEOUT_MS = 2000; // map round trip is X client -> Xwayland -> satellite -> Niri
const POLL_MS = 50;

let lastProblem = null; // the most recent probe's answer, reused while the bar is busy
let running = null; // the probe in progress, shared by overlapping callers

async function listWindows() {
  return (await request("Windows")).Windows;
}

function findBar(windows) {
  return windows.find((w) => w.title === BAR_TITLE) || null;
}

/** The setup card for what Niri did with the bar, or null if the rule is doing its job. */
function problemFor(win) {
  if (win.is_floating && !win.is_focused) return null;
  return {
    code: CODE,
    title: "Add a Niri window rule for the recording bar",
    detail: "Without it, Niri gives the recording bar keyboard focus each time it appears, so "
      + "pasting can miss the app you were dictating into"
      + (win.is_floating ? "" : ", and the bar opens as a new column instead of floating")
      + ". Add this rule to your Niri config (~/.config/niri/config.kdl), then re-check -- "
      + "Niri reloads its config automatically.",
    commands: RULE,
  };
}

/**
 * Shows the bar briefly and returns the card for what Niri did with it, or null.
 * `isBusy()` is true while the bar is in use (recording or transcribing): then the bar is left
 * alone and the previous answer stands.
 */
function probe(opts) {
  return running || (running = runProbe(opts).finally(() => { running = null; }));
}

async function runProbe({ show, hide, isBusy, log }) {
  if (isBusy()) return lastProblem;
  show();
  let win = null;
  try {
    const deadline = Date.now() + FIND_TIMEOUT_MS;
    while (!(win = findBar(await listWindows())) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (e) {
    log("warn", `niri window-rule check failed: ${e.message}`);
    return lastProblem;
  } finally {
    // A recording that started meanwhile owns the bar now
    if (!isBusy()) hide();
  }
  if (!win) {
    log("warn", `niri window-rule check: no window titled "${BAR_TITLE}" appeared`);
    return lastProblem;
  }
  log("info", `niri window-rule check: app_id=${win.app_id}, floating=${win.is_floating}, `
    + `focused=${win.is_focused}`);
  lastProblem = problemFor(win);
  return lastProblem;
}

module.exports = { CODE, probe, _internal: { findBar, problemFor, BAR_TITLE } };
