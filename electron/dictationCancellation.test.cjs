const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDictationCancellation } = require("./dictationCancellation.cjs");

function setup(available = true) {
  const bindings = new Map();
  const events = [];
  let window = { webContents: {}, isDestroyed: () => false };
  const controller = createDictationCancellation({
    shortcuts: {
      register: (key, callback) => {
        if (!available) return false;
        bindings.set(key, callback);
        return true;
      },
      unregister: (key) => bindings.delete(key),
      isRegistered: (key) => bindings.has(key),
    },
    getWindow: () => window,
    onCancel: () => events.push("restore-audio-and-hide"),
    replaceWindow: () => {
      events.push("replace-window");
      window = { webContents: {}, isDestroyed: () => false };
    },
    log: (level, message) => events.push({ level, message }),
  });
  return { controller, bindings, events, getWindow: () => window };
}

test("Escape is not captured while idle", () => {
  const { controller, bindings, events } = setup();
  assert.equal(controller.cancel(), false);
  assert.equal(bindings.size, 0);
  assert.equal(events.length, 0);
});

for (const phase of ["starting", "recording", "transcribing", "formatting"]) {
  test(`Escape cancels during ${phase} and rejects late output`, () => {
    const { controller, bindings, events, getWindow } = setup();
    const previousSender = getWindow().webContents;
    controller.setActive(true);
    assert.equal(controller.acceptsSender(previousSender), true);
    bindings.get("Escape")();
    assert.equal(bindings.size, 0);
    assert.equal(controller.acceptsSender(previousSender), false);
    assert.equal(controller.acceptsSender(getWindow().webContents), true);
    assert.deepEqual(events.slice(0, 2), ["restore-audio-and-hide", "replace-window"]);
    assert.equal(controller.cancel(), false);
    // A new recording must not inherit the previous document's cancellation.
    controller.setActive(true);
    assert.equal(bindings.has("Escape"), true);
    assert.equal(controller.acceptsSender(previousSender), false);
  });
}

test("normal completion releases Escape without rejecting valid output", () => {
  const { controller, bindings, getWindow } = setup();
  controller.setActive(true);
  controller.setActive(false);
  assert.equal(bindings.size, 0);
  assert.equal(controller.acceptsSender(getWindow().webContents), true);
});

test("tray cancellation still works if another application owns Escape", () => {
  const { controller, bindings, events } = setup(false);
  controller.setActive(true);
  assert.equal(bindings.size, 0);
  assert.ok(events.some((e) => e.level === "warn"));
  assert.equal(controller.cancel(), true);
});

test("shortcut rebinding keeps cancellation available", () => {
  const { controller, bindings } = setup();
  controller.setActive(true);
  bindings.clear();
  controller.refreshShortcut();
  assert.equal(bindings.has("Escape"), true);
});
