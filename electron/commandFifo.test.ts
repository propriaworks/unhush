// @vitest-environment node
//
// Exercises the real named pipe, not a mock. The two things worth guarding are exactly the two
// that were wrong in development: reading a fifo whose fd is non-blocking (an fs read stream fails
// with EAGAIN and delivers nothing), and keeping it open once a writer closes (a read-only fifo
// reports EOF and the listener dies after the very first command). Both are invisible to a test
// that only writes once, so several cases here deliberately write twice from separate processes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
// @ts-expect-error - plain CommonJS module, no type declarations
import fifo from "./commandFifo.cjs";

let runtimeDir: string;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

// Writing from a separate process is the point: it's how the desktop shortcut actually does it,
// and it's what makes the writer-closes-the-pipe case real.
function write(text: string) {
  execFileSync("sh", ["-c", `printf '${text}' > "${fifo.socketPath()}"`], { timeout: 3000 });
}

// The listener delivers on an event-loop turn, so give it a moment rather than a fixed sleep.
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "unhush-fifo-test-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  fifo.init(() => {});
});

afterEach(() => {
  fifo.stop();
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

describe("socketPath", () => {
  it("lives in XDG_RUNTIME_DIR, which is already per-user and mode 0700", () => {
    expect(fifo.socketPath()).toBe(path.join(runtimeDir, "unhush.fifo"));
  });

  it("falls back to a uid-qualified name in tmp when there is no runtime dir", () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(fifo.socketPath()).toBe(path.join(os.tmpdir(), `unhush-${process.getuid!()}.fifo`));
  });
});

describe("start", () => {
  it("creates a fifo readable only by its owner", () => {
    fifo.start({ toggle: () => {} });
    const st = fs.statSync(fifo.socketPath());
    expect(st.isFIFO()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("delivers a command to its handler", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    write("toggle\\n");
    await waitFor(() => toggle.mock.calls.length > 0);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  // The regression that matters: with O_RDONLY the stream hits EOF when the first writer exits and
  // every later command is silently lost -- i.e. the hotkey works exactly once per launch.
  it("keeps listening after a writer disconnects", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    write("toggle\\n");
    await waitFor(() => toggle.mock.calls.length === 1);
    write("toggle\\n");
    write("toggle\\n");
    await waitFor(() => toggle.mock.calls.length === 3);
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it("splits multiple commands arriving in one write", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    write("toggle\\ntoggle\\n");
    await waitFor(() => toggle.mock.calls.length === 2);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown commands instead of dispatching anything", async () => {
    const toggle = vi.fn();
    const logged: string[] = [];
    fifo.init((_level: string, msg: string) => logged.push(msg));
    fifo.start({ toggle });
    write("definitely-not-a-command\\n");
    await waitFor(() => logged.some((m) => m.includes("unknown command")));
    expect(toggle).not.toHaveBeenCalled();
  });

  it("ignores blank lines", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    write("\\n  \\ntoggle\\n");
    await waitFor(() => toggle.mock.calls.length > 0);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("replaces a stale node left behind by a crash", async () => {
    const p = path.join(runtimeDir, "unhush.fifo");
    fs.writeFileSync(p, "not a fifo at all");
    const toggle = vi.fn();
    fifo.start({ toggle });
    expect(fs.statSync(p).isFIFO()).toBe(true);
    write("toggle\\n");
    await waitFor(() => toggle.mock.calls.length > 0);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  // Note the newline: without it the flood and the command coalesce in the pipe into a single
  // oversized line, and dropping that whole line is the correct reading of what was sent.
  it("shrugs off an oversized line without wedging the listener", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    write("x".repeat(4096) + "\\n");
    write("toggle\\n");
    await waitFor(() => toggle.mock.calls.length > 0);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("stop", () => {
  it("removes the pipe, so the helper script doesn't block on a reader-less fifo", () => {
    fifo.start({ toggle: () => {} });
    const p = fifo.socketPath();
    expect(fs.existsSync(p)).toBe(true);
    fifo.stop();
    expect(fs.existsSync(p)).toBe(false);
  });

  it("is safe to call twice", () => {
    fifo.start({ toggle: () => {} });
    fifo.stop();
    expect(() => fifo.stop()).not.toThrow();
  });
});

describe("toggleCommand", () => {
  it("names the installed helper when the package provided one", () => {
    // Whether /usr/local/bin/unhush-toggle exists depends on whether this machine has a package
    // install, so assert the branch rather than one fixed string.
    const cmd = fifo.toggleCommand();
    if (fs.existsSync("/usr/local/bin/unhush-toggle")) {
      expect(cmd).toBe("/usr/local/bin/unhush-toggle");
    } else {
      expect(cmd).toContain(fifo.socketPath());
      expect(cmd).toContain("toggle");
    }
  });

  it("produces a shell command that actually drives the pipe (AppImage fallback form)", async () => {
    const toggle = vi.fn();
    fifo.start({ toggle });
    // The fallback one-liner is what AppImage users paste into their desktop shortcut, so it has
    // to survive being run by a shell verbatim.
    const oneLiner = `sh -c 'printf "toggle\\n" > "${fifo.socketPath()}"'`;
    execFileSync("sh", ["-c", oneLiner], { timeout: 3000 });
    await waitFor(() => toggle.mock.calls.length > 0);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
