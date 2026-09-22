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

const {
  defaultSocketPath, managedSocketPath, installCommandFor, isRpmDistroFor,
  generationFromHelp, chooseInstall, pasteKeyArgsFor,
} = ydotool._internal;

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

// ydotool 0.1.8's own `help` output, verbatim (Ubuntu/Mint).
const HELP_0X = `Usage: ydotool <cmd> <args>
Available commands:
  type
  recorder
  mousemove
  key
  click
`;

// ydotool 1.0.4's, likewise.
const HELP_1X = `Usage: ydotool <cmd> <args>
Available commands:
  click
  mousemove
  type
  key
  debug
  bakers
Use environment variable YDOTOOL_SOCKET to specify daemon socket.
`;

describe("generationFromHelp", () => {
  // Everything downstream hangs off this one decision: 0.x writes /dev/uinput itself and takes
  // key names, 1.x needs a daemon and takes keycodes. Guessing it from which files exist is what
  // broke before -- Ubuntu's 0.1.8 package ships a ydotoold too.
  it("recognises 0.x by its command list", () => {
    expect(generationFromHelp(HELP_0X)).toBe(0);
  });

  it("recognises 1.x by its debug command and socket footer", () => {
    expect(generationFromHelp(HELP_1X)).toBe(1);
  });

  it("still says 1.x if only the socket footer survives a future reword", () => {
    expect(generationFromHelp("Usage: ydotool <cmd>\nUse environment variable YDOTOOL_SOCKET.\n")).toBe(1);
  });

  it("reports null rather than guessing when the output is unrecognisable", () => {
    expect(generationFromHelp("")).toBe(null);
    expect(generationFromHelp("ydotool: command not found")).toBe(null);
  });
});

describe("chooseInstall", () => {
  const v1 = { client: "/home/u/.local/bin/ydotool", gen: 1, daemon: "/home/u/.local/bin/ydotoold" };
  const v1NoDaemon = { client: "/usr/local/bin/ydotool", gen: 1, daemon: null };
  const v0 = { client: "/usr/bin/ydotool", gen: 0, daemon: "/usr/bin/ydotoold" };

  // The regression: at login a systemd --user unit has systemd's built-in PATH, so /usr/bin's
  // 0.x came first and was chosen, its ydotoold silently ignored --socket-path, and Unhush
  // reported "the daemon isn't running" while leaking a ydotoold per attempt.
  it("prefers a complete 1.x install over an 0.x that comes first", () => {
    expect(chooseInstall([v0, v1])).toBe(v1);
  });

  it("takes a self-contained 0.x over a 1.x client with no daemon beside it", () => {
    expect(chooseInstall([v1NoDaemon, v0])).toBe(v0);
  });

  it("falls back to a lone 1.x client, which can still adopt someone else's daemon", () => {
    expect(chooseInstall([v1NoDaemon])).toBe(v1NoDaemon);
  });

  it("keeps PATH order between installs of equal standing", () => {
    const first = { ...v1, client: "/a/ydotool" };
    const second = { ...v1, client: "/b/ydotool" };
    expect(chooseInstall([first, second])).toBe(first);
  });

  it("returns nothing when ydotool isn't installed", () => {
    expect(chooseInstall([])).toBeFalsy();
  });
});

describe("typeStdinArgs", () => {
  // Both of ydotool's delays default to 20ms, so setting only --key-delay leaves that hold
  // underneath: the period is hold + gap, not the flag alone. Halving keeps the two backends
  // typing at the same speed for the same requested period.
  it("splits the per-character period into an equal hold and gap", () => {
    expect(ydotool.typeStdinArgs(32)).toEqual(
      ["type", "--key-hold", "16", "--key-delay", "16", "--file", "-"]);
  });

  // A period small enough to round to zero must still press the key for a measurable time.
  it("never emits a zero hold", () => {
    expect(ydotool.typeStdinArgs(1)).toEqual(
      ["type", "--key-hold", "1", "--key-delay", "1", "--file", "-"]);
  });
});

describe("pasteKeyArgsFor", () => {
  // 0.x parses key *names*, and answers anything else by typing that token's first character:
  // traced against the real 0.1.8 binary, "42:1" emits KEY_4 and "f13" emits KEY_F, both with
  // exit status 0. Sending it the 1.x keycode sequence types "4114" into the focused window.
  it("spells Shift+Insert as key names for 0.x", () => {
    expect(pasteKeyArgsFor(0, 20)).toEqual(["key", "--key-delay", "20", "shift+Insert"]);
  });

  it("uses keycode:state pairs for 1.x", () => {
    expect(pasteKeyArgsFor(1, 20))
      .toEqual(["key", "--key-delay", "20", "42:1", "110:1", "110:0", "42:0"]);
  });

  it("treats an undetected generation as 1.x", () => {
    expect(pasteKeyArgsFor(null, 20)).toEqual(pasteKeyArgsFor(1, 20));
  });
});
