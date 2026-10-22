// Run with Electron --no-sandbox. Uses synthetic microphone audio and a loopback-only
// mock transcription service. Never calls a real provider or writes to the clipboard.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDictationCancellation } = require("./dictationCancellation.cjs");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unhush-cancel-test-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.on("window-all-closed", () => {});

function deadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 10000); }),
  ]).finally(() => clearTimeout(timer));
}

app.whenReady().then(async () => {
  let window;
  let requestStarted;
  let requestClosed;
  let outputArrived;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const closed = new Promise((resolve) => { requestClosed = resolve; });
  const output = new Promise((resolve) => { outputArrived = resolve; });
  const outputs = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/transcribe") {
      requestStarted();
      res.on("close", requestClosed);
      return; // Deliberately pending until the recording document is destroyed.
    }
    if (req.url === "/transcribe-normal") {
      res.end("New recording succeeds");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<script>
      const { ipcRenderer } = require('electron');
      navigator.mediaDevices.getUserMedia({audio:true}).then(stream => {
        window.recordingStream = stream;
        return fetch(location.search ? '/transcribe-normal' : '/transcribe');
      }).then(r => r.text()).then(text => ipcRenderer.send('test-output', text));
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  function newWindow() {
    window = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: true, contextIsolation: false, sandbox: false,
      backgroundThrottling: false,
    } });
    return window;
  }
  const bindings = new Map();
  const controller = createDictationCancellation({
    shortcuts: {
      register: (key, callback) => { bindings.set(key, callback); return true; },
      unregister: (key) => bindings.delete(key),
      isRegistered: (key) => bindings.has(key),
    },
    getWindow: () => window,
    replaceWindow: () => { window.destroy(); newWindow(); },
    onCancel: () => {},
    log: () => {},
  });
  ipcMain.on("test-output", (event, text) => {
    if (!controller.acceptsSender(event.sender)) return;
    outputs.push(text);
    controller.setActive(false);
    outputArrived();
  });
  try {
    const oldWindow = newWindow();
    const oldSender = oldWindow.webContents;
    controller.setActive(true);
    await oldWindow.loadURL(url);
    await deadline(started, "synthetic capture and pending request");
    assert.equal(await oldSender.executeJavaScript("recordingStream.getTracks()[0].readyState"), "live");
    bindings.get("Escape")();
    assert.equal(oldWindow.isDestroyed(), true);
    assert.equal(controller.acceptsSender(oldSender), false);
    await deadline(closed, "cancelled request disconnected");
    assert.deepEqual(outputs, []);
    assert.equal(bindings.size, 0);
    controller.setActive(true);
    await window.loadURL(url + "/?normal=1");
    await deadline(output, "new recording output");
    assert.deepEqual(outputs, ["New recording succeeds"]);
    console.log("PASS: cancellation destroys live capture, disconnects pending fetch, rejects stale output, releases Escape, and allows the next recording.");
  } finally {
    window?.destroy();
    server.closeAllConnections();
    server.close();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
