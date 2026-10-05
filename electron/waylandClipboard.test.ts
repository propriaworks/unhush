// @vitest-environment node
//
// The pure decisions (spotting xwayland-satellite, picking the type to save) and wlCopy's process
// handling. No compositor is involved: wlCopy runs a stand-in script that behaves like wl-copy --
// the parent exits once the selection is "set", leaving a child that still holds stderr -- which
// is the case where waiting for the pipes to close would hang until the next copy.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
// @ts-expect-error - plain CommonJS module, no type declarations
import { _internal } from "./waylandClipboard.cjs";
const { isSatelliteCmdline, chooseType, wlCopy, setTools } = _internal;

describe("isSatelliteCmdline", () => {
  it("matches satellite by argv[0], with or without a directory", () => {
    expect(isSatelliteCmdline("xwayland-satellite\0:0\0-listenfd\x0012\0")).toBe(true);
    expect(isSatelliteCmdline("/usr/bin/xwayland-satellite\0:1\0")).toBe(true);
  });

  it("ignores other processes, including ones that only mention satellite in arguments", () => {
    expect(isSatelliteCmdline("niri\0--session\0")).toBe(false);
    expect(isSatelliteCmdline("vim\0xwayland-satellite\0")).toBe(false);
    expect(isSatelliteCmdline("")).toBe(false);
  });
});

describe("chooseType", () => {
  it("prefers UTF-8 plain text over the other text types", () => {
    expect(chooseType(["text/html", "STRING", "text/plain", "text/plain;charset=utf-8"]))
      .toBe("text/plain;charset=utf-8");
    expect(chooseType(["text/html", "UTF8_STRING"])).toBe("UTF8_STRING");
  });

  it("keeps an image-only copy as its image", () => {
    expect(chooseType(["image/png", "image/jpeg"])).toBe("image/png");
  });

  it("restores nothing when there is neither text nor an image", () => {
    expect(chooseType(["application/x-custom"])).toBe(null);
    expect(chooseType([])).toBe(null);
  });
});

describe("wlCopy", () => {
  let dir: string;
  let childPidFile: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unhush-wlcopy-"));
    childPidFile = path.join(dir, "child.pid");
    const script = path.join(dir, "wl-copy");
    // Reads stdin into a file, as wl-copy spools it; "--fail" exits 1 with a message, like a
    // missing compositor; otherwise a background child keeps stderr open and the parent exits 0.
    fs.writeFileSync(script, `#!/bin/sh
cat > "${dir}/stdin"
echo "$@" > "${dir}/args"
if [ "$1" = "--fail" ]; then echo "Failed to connect to a Wayland server" >&2; exit 1; fi
sleep 30 < /dev/null > /dev/null &
echo $! > "${childPidFile}"
exit 0
`, { mode: 0o755 });
    setTools({ copy: script, paste: "/nonexistent" });
  });

  afterAll(() => {
    try { process.kill(Number(fs.readFileSync(childPidFile, "utf8")), "SIGTERM"); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves when wl-copy exits, though its forked child still holds stderr", async () => {
    const t0 = Date.now();
    await wlCopy(["--type", "text/plain;charset=utf-8"], "hello transcript");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe("hello transcript");
    expect(fs.readFileSync(path.join(dir, "args"), "utf8").trim()).toBe("--type text/plain;charset=utf-8");
  });

  it("rejects with wl-copy's own message when it fails", async () => {
    await expect(wlCopy(["--fail"], "x")).rejects.toThrow(/exit 1.*Failed to connect to a Wayland server/);
  });
});
