// The only module that touches Electron's clipboard. Everything above it (textOutput.cjs, the
// tray, IPC) goes through these four functions, so an Electron clipboard API change is confined
// to this file -- and checked against a real X server by clipboardAccess.integration.cjs
// (`pnpm test:clipboard`), since unit tests can only fake it.
//
// The functions are async although Electron 43's clipboard is synchronous: Electron 44 made the
// API promise-based, and keeping the async shape here lets that migration replace this file
// without touching its callers.

const { clipboard } = require("electron");

// Write the text to both X selections, deliberately. Shift+Insert is historically the
// *primary*-selection paste in X11 and terminals still bind it that way, while GUI toolkits read
// CLIPBOARD; PRIMARY also makes middle-click paste work. Writing only one would silently paste
// nothing in whichever half of the desktop doesn't match. The 'selection' type is a no-op off Linux.
// (On X11, Electron also copies a CLIPBOARD write onto PRIMARY by itself -- observed under Xvfb --
// but that is undocumented, so the explicit write stays.)
async function writeTextBoth(text) {
  clipboard.writeText(text);
  clipboard.writeText(text, "selection");
}

async function readText() {
  return clipboard.readText();
}

function snapshot(type) {
  const saved = {};
  const formats = clipboard.availableFormats(type);
  if (formats.some(f => f.startsWith("text/plain"))) saved.text = clipboard.readText(type);
  if (formats.some(f => f.startsWith("text/html"))) saved.html = clipboard.readHTML(type);
  if (formats.some(f => f.startsWith("image/"))) saved.image = clipboard.readImage(type);
  if (formats.some(f => f.startsWith("text/rtf"))) saved.rtf = clipboard.readRTF(type);
  return saved;
}

// Returns an opaque snapshot of both selections for restore().
async function save() {
  return { clipboard: snapshot("clipboard"), selection: snapshot("selection") };
}

async function restore(saved) {
  if (Object.keys(saved.clipboard).length > 0) clipboard.write(saved.clipboard);
  if (Object.keys(saved.selection).length > 0) clipboard.write(saved.selection, "selection");
}

module.exports = { writeTextBoth, readText, save, restore };
