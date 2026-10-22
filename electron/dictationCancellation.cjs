// Cancellation disposes the recording document instead of finalizing its audio queue.
// Destroying the BrowserWindow releases capture and aborts document-owned fetches/timers.
// A sender identity guard also rejects output already queued by the disposed document.
function createDictationCancellation({ shortcuts, getWindow, replaceWindow, onCancel, log }) {
  let active = false;
  let ownsEscape = false;

  function refreshShortcut() {
    if (!active) return;
    if (ownsEscape && shortcuts.isRegistered("Escape")) return;
    ownsEscape = shortcuts.register("Escape", cancel);
    if (!ownsEscape) log("warn", "Escape could not be registered; use Cancel Dictation in the tray menu");
  }

  function setActive(value) {
    active = value;
    if (active) refreshShortcut();
    else if (ownsEscape) {
      shortcuts.unregister("Escape");
      ownsEscape = false;
    }
  }

  function cancel() {
    if (!active) return false;
    setActive(false);
    onCancel();
    // Replace the whole document: startup promises, VAD callbacks, retry timers and
    // late STT/LLM responses cannot carry over into the next recording.
    replaceWindow();
    log("info", "Dictation cancelled; audio capture stopped and pending output discarded");
    return true;
  }

  function acceptsSender(sender) {
    const window = getWindow();
    return !!window && !window.isDestroyed() && sender === window.webContents;
  }

  return { setActive, refreshShortcut, cancel, acceptsSender };
}

module.exports = { createDictationCancellation };
