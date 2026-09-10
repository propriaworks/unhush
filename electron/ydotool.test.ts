// @vitest-environment node
//
// Covers the parts of the ydotool paste path that are pure decisions rather than process
// wrangling: where the daemon socket goes, and which package manager to name when ydotool is
// missing. The socket path carries a non-obvious constraint — AF_UNIX sun_path is 108 bytes and
// both ydotool and ydotoold *silently* truncate to it, so two different long paths can collide
// after truncation and the daemon then refuses to start. That guard cost a debugging session
// during development, so it gets a test.
//
// Daemon spawning, socket probing and /dev/uinput access all talk to the real system and are
// verified by hand on each platform instead.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
// @ts-expect-error - plain CommonJS module, no type declarations
import ydotool from "./ydotool.cjs";

const { defaultSocketPath, managedSocketPath, installCommandFor, isRpmDistroFor } =
  ydotool._internal;

const savedEnv = { ...process.env };

beforeEach(() => {
  ydotool.init(() => {}, "/home/someone/.config/unhush");
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("defaultSocketPath", () => {
  // Mirrors ydotool's own resolution (Client/ydotool.c, Daemon/ydotoold.c). We need it exactly
  // right because we probe it at startup to adopt a daemon somebody else already started.
  it("uses XDG_RUNTIME_DIR when the session has one", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(defaultSocketPath()).toBe("/run/user/1000/.ydotool_socket");
  });

  it("falls back to /tmp, as ydotool does", () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(defaultSocketPath()).toBe("/tmp/.ydotool_socket");
  });
});

describe("managedSocketPath", () => {
  it("is distinct from ydotool's default, so a distro daemon can coexist", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(managedSocketPath()).toBe("/run/user/1000/unhush-ydotool.sock");
    expect(managedSocketPath()).not.toBe(defaultSocketPath());
  });

  it("lives under userData when there is no runtime dir", () => {
    delete process.env.XDG_RUNTIME_DIR;
    ydotool.init(() => {}, "/home/someone/.config/unhush");
    expect(managedSocketPath()).toBe("/home/someone/.config/unhush/ydotool.sock");
  });

  // The regression this guard exists for: a path at or past the sun_path limit is truncated by
  // both binaries without complaint, so the client and daemon can end up on different paths that
  // look identical, and ydotoold exits rather than starting.
  it("escapes to /tmp when the natural path would approach the 108-byte sun_path limit", () => {
    delete process.env.XDG_RUNTIME_DIR;
    ydotool.init(() => {}, "/home/a-user-with-a-really-quite-extraordinarily-long-home-directory-name/.config/unhush");
    const p = managedSocketPath();
    expect(p).toBe(`/tmp/unhush-ydotool-${process.getuid!()}.sock`);
    expect(Buffer.byteLength(p)).toBeLessThan(100);
  });

  it("keeps every produced path safely inside the sun_path limit", () => {
    for (const dir of ["/run/user/1000", "/run/user/1000000", undefined]) {
      if (dir) process.env.XDG_RUNTIME_DIR = dir;
      else delete process.env.XDG_RUNTIME_DIR;
      expect(Buffer.byteLength(managedSocketPath())).toBeLessThan(108);
    }
  });
});

describe("env", () => {
  it("pins YDOTOOL_SOCKET, without which the client looks at its own default and misses us", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const e = ydotool.env();
    expect(e.YDOTOOL_SOCKET).toBe(ydotool.socketPath());
    expect(e.PATH).toBe(process.env.PATH); // still a full environment, not a replacement
  });
});

describe("installCommandFor", () => {
  it.each([
    ["fedora", "sudo dnf install ydotool"],
    ["rhel", "sudo dnf install ydotool"],
    ["centos", "sudo dnf install ydotool"],
    ["arch", "sudo pacman -S ydotool"],
    ["opensuse-tumbleweed suse", "sudo zypper install ydotool"],
    ["ubuntu debian", "sudo apt install ydotool"],
    ["debian", "sudo apt install ydotool"],
  ])("maps %s to %s", (distro, expected) => {
    expect(installCommandFor(distro)).toBe(expected);
  });

  it("falls back to apt for an unrecognised distro rather than saying nothing", () => {
    expect(installCommandFor("")).toBe("sudo apt install ydotool");
    expect(installCommandFor("some-new-distro")).toBe("sudo apt install ydotool");
  });

  // ID_LIKE is what catches derivatives: Nobara says ID=nobara, ID_LIKE=fedora.
  it("recognises a derivative through its ID_LIKE", () => {
    expect(installCommandFor("nobara fedora")).toBe("sudo dnf install ydotool");
    expect(installCommandFor("linuxmint ubuntu debian")).toBe("sudo apt install ydotool");
  });
});

describe("isRpmDistroFor", () => {
  it("gates the Fedora-specific advice in the setup window", () => {
    expect(isRpmDistroFor("fedora")).toBe(true);
    expect(isRpmDistroFor("ubuntu debian")).toBe(false);
    expect(isRpmDistroFor("arch")).toBe(false);
  });
});
