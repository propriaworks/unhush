// @vitest-environment node
//
// Covers the decisions in textOutput.cjs: which output path runs, what it writes to the
// clipboard, which ydotool commands it sends, and when the previous clipboard is restored.
// Everything that touches the system is faked, so this cannot show that a keystroke really lands
// in an app, or that Electron's clipboard really writes both X selections -- the latter is
// clipboardAccess.integration.cjs's job (`pnpm test:clipboard`).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// @ts-expect-error - plain CommonJS module, no type declarations
import textOutput from "./textOutput.cjs";

const PASTE_ARGS = ["key", "shift+insert"];
const TYPE_ARGS = ["type", "--file", "-"];
const SAVED = { clipboard: { text: "previous" }, selection: {} };

// Fake clipboard with state, so "does it still hold our transcript?" can be tested directly.
function makeClipboard() {
  const cb = {
    contents: "previous",
    writeTextBoth: vi.fn(async (text: string) => { cb.contents = text; }),
    readText: vi.fn(async () => cb.contents),
    save: vi.fn(async () => SAVED),
    restore: vi.fn(async () => { cb.contents = "previous"; }),
  };
  return cb;
}

// Fake execFileAsync. Like the real promisified execFile, the returned promise carries .child, so
// the type path can write the transcript to stdin. `fail` makes every call reject.
function makeExec() {
  const calls: { file: string; args: string[]; opts: any; stdin?: string }[] = [];
  const exec = {
    calls,
    fail: false,
    fn: vi.fn((file: string, args: string[], opts: any) => {
      const call: (typeof calls)[number] = { file, args, opts };
      calls.push(call);
      const p: any = Promise.resolve().then(() => {
        if (exec.fail) throw new Error("ydotool exploded");
        return { stdout: "", stderr: "" };
      });
      p.child = { stdin: { end: (data: string) => { call.stdin = data; } } };
      return p;
    }),
  };
  return exec;
}

let clipboard: ReturnType<typeof makeClipboard>;
let exec: ReturnType<typeof makeExec>;
let deps: any;

function setup(overrides: Record<string, unknown> = {}) {
  deps = {
    clipboard,
    ydotool: {
      clientPath: () => "/usr/bin/ydotool",
      pasteKeyArgs: vi.fn(() => PASTE_ARGS),
      typeStdinArgs: vi.fn(() => TYPE_ARGS),
      env: () => ({ YDOTOOL_SOCKET: "/run/test.sock" }),
    },
    execFileAsync: exec.fn,
    getActiveWindowInfo: vi.fn(async () => ({ app: "kitty", title: "shell" })),
    log: vi.fn(),
    isDebug: () => false, // keeps the xclip diagnostics out of the exec calls
    isX11: () => true,
    msSinceHotkey: () => 100,
    onOutput: vi.fn(),
    onDestination: vi.fn(),
    ...overrides,
  };
  textOutput.init(deps);
}

// Runs outputText to completion, moving the fake clock past doPaste's 250ms settle delay.
async function run(text: string, method: string) {
  const done = textOutput.outputText(text, method);
  await vi.advanceTimersByTimeAsync(250);
  return done;
}

const pasteKeyCalls = () => exec.calls.filter((c) => c.args === PASTE_ARGS);

beforeEach(() => {
  vi.useFakeTimers();
  clipboard = makeClipboard();
  exec = makeExec();
  setup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clipboard mode", () => {
  it("writes both selections and sends no keystroke", async () => {
    expect(await run("hello", "clipboard")).toBe(true);
    expect(clipboard.writeTextBoth).toHaveBeenCalledWith("hello");
    expect(exec.fn).not.toHaveBeenCalled();
    expect(deps.onOutput).toHaveBeenCalledWith("hello");
  });

  it("is used instead of paste or type when ydotool is missing", async () => {
    setup({ ydotool: { ...deps.ydotool, clientPath: () => null } });
    for (const method of ["paste", "type"]) {
      await run("hello", method);
    }
    expect(clipboard.writeTextBoth).toHaveBeenCalledTimes(2);
    expect(exec.fn).not.toHaveBeenCalled();
  });

  it("does nothing for empty text", async () => {
    expect(await run("", "paste")).toBe(true);
    expect(clipboard.writeTextBoth).not.toHaveBeenCalled();
    expect(deps.onOutput).not.toHaveBeenCalled();
  });

  it("logs a failed clipboard write rather than throwing", async () => {
    clipboard.writeTextBoth.mockRejectedValueOnce(new Error("no display"));
    expect(await run("hello", "clipboard")).toBe(true);
    expect(deps.log).toHaveBeenCalledWith("error", expect.stringContaining("no display"));
  });
});

describe("paste mode", () => {
  it("saves the old clipboard, writes the transcript, then sends the paste key", async () => {
    await run("hello", "paste");
    const saveOrder = clipboard.save.mock.invocationCallOrder[0];
    const writeOrder = clipboard.writeTextBoth.mock.invocationCallOrder[0];
    const keyOrder = exec.fn.mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(keyOrder);
    expect(pasteKeyCalls()).toHaveLength(1);
    expect(deps.ydotool.pasteKeyArgs).toHaveBeenCalledWith(20);
    expect(exec.calls[0].opts.env).toEqual({ YDOTOOL_SOCKET: "/run/test.sock" });
  });

  it("waits 250ms after writing before sending the key", async () => {
    const done = textOutput.outputText("hello", "paste");
    await vi.advanceTimersByTimeAsync(249);
    expect(exec.fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(pasteKeyCalls()).toHaveLength(1);
  });

  it("reports the destination window", async () => {
    await run("hello", "paste");
    expect(deps.onDestination).toHaveBeenCalledWith({ app: "kitty", title: "shell" });
  });

  it("restores the old clipboard 3s later, not before", async () => {
    await run("hello", "paste");
    await vi.advanceTimersByTimeAsync(2999);
    expect(clipboard.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.restore).toHaveBeenCalledWith(SAVED);
  });

  it("does not restore if something else has taken the clipboard since", async () => {
    await run("hello", "paste");
    clipboard.contents = "copied by the user meanwhile";
    await vi.advanceTimersByTimeAsync(3000);
    expect(clipboard.restore).not.toHaveBeenCalled();
  });

  it("leaves the transcript on the clipboard if the paste key fails", async () => {
    exec.fail = true;
    expect(await run("hello", "paste")).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(clipboard.restore).not.toHaveBeenCalled();
    expect(clipboard.contents).toBe("hello");
    expect(deps.log).toHaveBeenCalledWith("error", expect.stringContaining("paste key simulation failed"));
  });

  it("still pastes when saving the old clipboard fails, and skips the restore", async () => {
    clipboard.save.mockRejectedValueOnce(new Error("owner not answering"));
    await run("hello", "paste");
    expect(pasteKeyCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(clipboard.restore).not.toHaveBeenCalled();
  });

  it("logs a failed restore rather than throwing", async () => {
    clipboard.restore.mockRejectedValueOnce(new Error("gone"));
    await run("hello", "paste");
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("restore failed"));
  });

  it("is the fallback for an unknown method", async () => {
    await run("hello", "carrier-pigeon");
    expect(pasteKeyCalls()).toHaveLength(1);
  });
});

describe("type mode", () => {
  it("types plain ASCII via stdin without touching the clipboard", async () => {
    await run("Hello, world!\n", "type");
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args).toBe(TYPE_ARGS);
    expect(exec.calls[0].stdin).toBe("Hello, world!\n");
    expect(deps.ydotool.typeStdinArgs).toHaveBeenCalledWith(32);
    expect(clipboard.writeTextBoth).not.toHaveBeenCalled();
    expect(clipboard.save).not.toHaveBeenCalled();
  });

  it("scales the timeout with length, with a 5s floor", async () => {
    await run("short", "type");
    await run("x".repeat(1000), "type");
    expect(exec.calls[0].opts.timeout).toBe(5000);
    expect(exec.calls[1].opts.timeout).toBe(50_000);
  });

  it("pastes instead when the text has characters ydotool can't type", async () => {
    await run("café", "type");
    expect(pasteKeyCalls()).toHaveLength(1);
    expect(clipboard.writeTextBoth).toHaveBeenCalledWith("café");
  });

  it("on failure leaves the text on the clipboard and does not paste", async () => {
    exec.fail = true;
    await run("hello", "type");
    expect(exec.calls).toHaveLength(1); // the type attempt only, no paste key afterwards
    expect(clipboard.writeTextBoth).toHaveBeenCalledWith("hello");
    expect(deps.log).toHaveBeenCalledWith("error", expect.stringContaining("ydotool type failed"));
  });
});
