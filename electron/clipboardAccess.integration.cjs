// Checks clipboardAccess.cjs against a real X server: `pnpm test:clipboard`, which runs this file
// as an Electron main process inside xvfb-run, so the desktop's own clipboard is never touched.
// Needs xvfb-run and xclip. Local only (not in CI).
//
// xclip stands in for the other applications: it puts content on a selection for us to save,
// and it reads back what we wrote, exactly as a pasting terminal or GUI app would. This is what
// the unit tests (textOutput.test.ts) cannot show: that the Electron clipboard API in use still
// exists and behaves as clipboardAccess.cjs assumes (Electron 44 removed availableFormats() and
// friends, which fails the save/restore test here).

const { app } = require("electron");
const assert = require("assert/strict");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const clipboardAccess = require("./clipboardAccess.cjs");

const execFileAsync = promisify(execFile);
const STEP_TIMEOUT_MS = 10000;

// Async on purpose: when we own the selection, xclip's read is a request that this process's
// event loop has to answer, so a synchronous call would deadlock.
async function xRead(selection, target = "UTF8_STRING") {
  const { stdout } = await execFileAsync("xclip", ["-o", "-selection", selection, "-t", target], { timeout: 3000 });
  return stdout;
}

// xclip takes ownership of the selection and forks into the background to serve it, so wait for
// the foreground process to exit rather than for its output pipes to close (the forked child
// holds those open until another owner takes over).
function xWrite(selection, target, data) {
  return new Promise((resolve, reject) => {
    const p = spawn("xclip", ["-i", "-selection", selection, "-t", target], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`xclip -i exited ${code}`))));
    p.stdin.end(data);
  });
}

const tests = {
  // Checks the outcome, not the mechanism: on X11, Electron (43 and 44 at least) also copies a
  // CLIPBOARD write onto PRIMARY by itself, so this passes even without the explicit selection write.
  async "writeTextBoth sets CLIPBOARD (GUI paste) and PRIMARY (terminal Shift+Insert)"() {
    await clipboardAccess.writeTextBoth("dictated text");
    assert.equal(await xRead("clipboard"), "dictated text");
    assert.equal(await xRead("primary"), "dictated text");
  },

  async "readText returns what another app put on CLIPBOARD"() {
    await xWrite("clipboard", "UTF8_STRING", "from another app");
    assert.equal(await clipboardAccess.readText(), "from another app");
  },

  async "save/restore brings back another app's HTML on CLIPBOARD and text on PRIMARY"() {
    const html = "<b>bold</b> and <i>italic</i>";
    await xWrite("clipboard", "text/html", html);
    await xWrite("primary", "UTF8_STRING", "selected words");

    const saved = await clipboardAccess.save();
    await clipboardAccess.writeTextBoth("transcript");
    assert.equal(await xRead("clipboard"), "transcript");
    assert.equal(await xRead("primary"), "transcript");

    await clipboardAccess.restore(saved);
    assert.equal(await xRead("clipboard", "text/html"), html);
    assert.equal(await xRead("primary"), "selected words");
  },
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.whenReady().then(async () => {
  console.log(`clipboardAccess integration (Electron ${process.versions.electron}, DISPLAY=${process.env.DISPLAY})`);
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await withTimeout(fn(), STEP_TIMEOUT_MS);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      const hint = err.code === "ENOENT" ? " (is xclip installed?)" : "";
      console.log(`  ✗ ${name}\n      ${err.message}${hint}`);
    }
  }
  const total = Object.keys(tests).length;
  console.log(failed ? `${failed} of ${total} failed` : `all ${total} passed`);
  app.exit(failed ? 1 : 0);
});
