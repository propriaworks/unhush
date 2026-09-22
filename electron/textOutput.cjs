// Delivers a finished transcript to the user: pasted, typed, or left on the clipboard. Moved out of
// main.cjs's "output-text" IPC handler so the decisions can be unit-tested (textOutput.test.ts):
// everything that touches the system comes in through init(), so tests can substitute fakes.
// The clipboard itself is behind clipboardAccess.cjs.

// Set by init():
//   clipboard            clipboardAccess.cjs: writeTextBoth / readText / save / restore
//   ydotool              ydotool.cjs: clientPath / pasteKeyArgs / typeStdinArgs / env
//   execFileAsync        promisified child_process.execFile
//   getActiveWindowInfo  activeWindow.cjs's, resolving to { app, title } | null
//   log                  (level, message)
//   isDebug              () => whether debug logging is on
//   isX11                () => whether this is an X11 (or XWayland) session
//   msSinceHotkey        () => ms since the toggle hotkey last fired, or -1
//   onOutput             (text) => called once per transcript, before delivery (tray: "Copy last")
//   onDestination        (info) => called when the target window has been identified (tray)
let clipboard, ydotool, execFileAsync, getActiveWindowInfo, log, isDebug, isX11, msSinceHotkey,
  onOutput, onDestination;

function init(deps) {
  ({ clipboard, ydotool, execFileAsync, getActiveWindowInfo, log, isDebug, isX11, msSinceHotkey,
    onOutput, onDestination } = deps);
}

// Returns true in every case, as the IPC handler always has; failures are logged, not thrown.
async function outputText(text, method) {
  if (!text) {
    log('info', 'output-text: no text to output');
    return true;
  }

  // If ydotool is not present/working, fall back to clipboard mode rather than failing.
  // Tell the user once, clearly.
  if ((method === "paste" || method === "type") && !ydotool.clientPath()) {
    log('error', `output-text: ydotool is not installed — leaving the text on the clipboard instead of using ${method}`);
    method = "clipboard";
  }

  log('info', `output-text: ${method} (${text.length} chars)`);
  onOutput(text);

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
    return getActiveWindowInfo().then(onDestination);
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
    if (!isDebug() || !isX11()) return;
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
    // A failed save only costs the restore below; it must not stop the paste itself.
    let saved = null;
    try {
      saved = await clipboard.save();
    } catch (err) {
      log('warn', `clipboard: could not save previous contents (${err.message}) — it won't be restored`);
    }
    await clipboard.writeTextBoth(text); // both selections -- see writeTextBoth for why
    await new Promise(resolve => setTimeout(resolve, 250));
    captureDestination();
    await xSelectionDiag('pre-key');
    const sinceHotkey = msSinceHotkey();
    const t0 = Date.now();
    let keySent = false;
    try {
      // execFile (async), not execSync: this keeps the main process' event loop free to service
      // the target app's clipboard-selection request, which we must answer as clipboard owner on
      // this same thread. Blocking here for the time ydotool takes to run risks stalling that
      // response right when it's needed most. Still awaited, so callers see the real outcome
      // and errors/timeouts are still caught below -- this isn't fire-and-forget.
      // The binary and the key syntax both come from ydotool.cjs since they depend on the version.
      const { stderr } = await execFileAsync(ydotool.clientPath(), ydotool.pasteKeyArgs(20), { timeout: 5000, env: ydotool.env() });
      keySent = true;
      log('debug', `paste-diag key: ydotool ok in ${Date.now() - t0}ms, ${sinceHotkey}ms after hotkey${stderr && stderr.trim() ? `, stderr: ${stderr.trim()}` : ''}`);
    } catch (err) {
      log('error', `output-text paste key simulation failed: ${err.message} — leaving the transcript on the clipboard`);
    }
    // One more reading after the paste should have landed, to catch ownership being lost/replaced
    // in the window around the keystroke itself.
    setTimeout(() => { xSelectionDiag('post-key+500ms'); }, 500);
    // Scheduled rather than awaited so this handler's promise resolves immediately instead of
    // keeping the renderer's invoke() pending for RESTORE_CLIPBOARD_DELAY_MS. Skipped in two
    // cases. If the clipboard no longer holds our transcript, the user (or a clipboard manager)
    // has since taken ownership, and blindly restoring the old value would clobber that rather
    // than be a harmless no-op. And if the keystroke never went out, we let the transcript stay
    // on the clipboard unpasted. The tray's "Copy last" can always put it back, so that is an
    // annoyance rather than a loss, but an avoidable one.
    setTimeout(async () => {
      try {
        if (keySent && saved && await clipboard.readText() === text) {
          await clipboard.restore(saved);
        }
      } catch (err) {
        log('warn', `clipboard restore failed: ${err.message}`);
      }
    }, RESTORE_CLIPBOARD_DELAY_MS);
  }

  try {
    switch (method) {
      case "paste":
        await doPaste();
        break;
      case "type": {
        // `ydotool type` maps each *byte* through a 128-entry US-QWERTY table (Client/tool_type.c),
        // in which only tab, newline and 0x20-0x7e have entries. Basically anything outside
        // ordinary English will fail, as will anything where the keyboard layout differs from QWERTY.
        // In the former case we can detect this and so we paste instead.
        if (/[^\t\n\x20-\x7e]/.test(text)) {
          log('info', "output-text: text has characters ydotool can't type — pasting instead");
          await doPaste();
          break;
        }
        // The dictated text goes to ydotool over stdin (`--file -`), so it never lands on disk
        // and never appears in a command line. This replaced a 0600 scratch file in
        // XDG_RUNTIME_DIR; the pipe is strictly better -- nothing to unlink, nothing for a crash
        // to leave behind.
        // Both of these are disabled on trial, and kept here because the reasoning is not
        // airtight. The 250ms was inherited from doPaste(), where it earns its place letting a
        // clipboard write settle before the paste key; nothing is written to the clipboard on
        // this path. It was also suspected of giving focus time to return to the target app --
        // but the recording pill is focusable:false and window-type notification, so it never
        // holds focus for the hotkey path. The tray's "Toggle Recording" item *does* take focus
        // while its menu is open, and that is the case to watch: there, a whole transcription
        // round trip (seconds) elapses before we get here, which should cover it many times over.
        // captureDestination() was awaited only because the old execFileSync blocked the event
        // loop for the entire typing run, so an un-awaited call would not have resolved until
        // afterwards; the async call below removed that reason.
        // Restore both if the first characters of a transcript ever go astray.
        // await new Promise(resolve => setTimeout(resolve, 250));
        // await captureDestination();
        captureDestination();
        const timeout = Math.max(5000, text.length * 50);
        // Time per character, start to start. ydotool splits it into a key hold and a gap, both
        // of which default to 20ms -- so setting only --key-delay leaves that hold underneath it.
        // Lower is faster; the point of Type mode is that the text is readable as it lands, so
        // this is a feel setting.
        const TYPE_PERIOD_MS = 32;
        // Note: Previously we used a --delay 100 to give time for the OS focus to return to the target app; seems no longer needed (?)
        // stderr is discarded: ydotool 0.x chatters on it ("File path was set to -.") even on success.
        try {
          // execFile (async), not execFileSync, for the reason doPaste() gives above: typing a
          // long transcript takes seconds, and execFileSync would block this process' event loop
          // for every one of them, leaving us unable to answer anything in the meantime.
          // Still awaited, so the catch below still sees real failures.
          const typing = execFileAsync(ydotool.clientPath(), ydotool.typeStdinArgs(TYPE_PERIOD_MS),
            { timeout, env: ydotool.env() });
          typing.child.stdin.end(text);
          await typing;
        } catch (err) {
          // Deliberately not doPaste(). That presses Shift+Insert through the same ydotool that
          // just failed, so the keystroke would almost certainly fail too -- and on a timeout it
          // is worse than useless: ydotool may already have typed part of the transcript, so
          // pasting the whole of it would duplicate what is there. Leave the text on the
          // clipboard instead, exactly as the "ydotool is not installed" path above does, and
          // let the user paste it themselves.
          log('error', `output-text: ydotool type failed (${err.message}) — left on the clipboard`);
          await clipboard.writeTextBoth(text);
        }
        break;
      }
      case "clipboard":
        await clipboard.writeTextBoth(text);
        break;
      default:
        log('warn', `output-text: unknown method "${method}", falling back to paste`);
        await doPaste();
    }
  } catch (err) {
    log('error', `output-text (${method}) failed: ${err.message}`);
  }
  return true;
}

module.exports = { init, outputText };
