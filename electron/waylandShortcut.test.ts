// @vitest-environment node
//
// This module decides, from the session type and our own argv, whether Unhush can bind the global
// hotkey itself or whether the desktop environment has to. That decision used to be a
// per-compositor, per-GNOME-version matrix; it is now a single condition, and these tests pin it
// down across the combinations that actually occur -- including the ones neither development
// machine can run (GNOME, wlroots), which is precisely why they're worth having.
//
// Session type and argv are read once at module load, so each case loads the module afresh.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// No electron mock needed: the module takes its userData path through init(), so it runs as plain
// node. (It previously required electron for app.getPath, which vi.mock cannot intercept from a
// .cjs require -- require("electron") outside an electron process just yields the binary path.)
const state = { userDataDir: "" };

const savedEnv = { ...process.env };
const savedArgv = process.argv;

type Case = { session?: string; desktop?: string; xwayland?: boolean };

async function load({ session, desktop, xwayland }: Case) {
  vi.resetModules();
  process.env.XDG_SESSION_TYPE = session ?? "x11";
  process.env.XDG_CURRENT_DESKTOP = desktop ?? "X-Cinnamon";
  process.env.XDG_RUNTIME_DIR = state.userDataDir;
  // The re-exec guard in main.cjs is what puts this on our command line.
  process.argv = ["/opt/Unhush/unhush", ...(xwayland ? ["--ozone-platform=x11"] : [])];
  const mod: any = await import("./waylandShortcut.cjs");
  const m = mod.default ?? mod;
  m.init(() => {}, state.userDataDir);
  return m;
}

// A Wayland session as Unhush actually runs on one: re-execed onto XWayland.
const wayland = (desktop: string): Case => ({ session: "wayland", desktop, xwayland: true });

beforeEach(() => {
  state.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unhush-shortcut-test-"));
});

afterEach(() => {
  process.env = { ...savedEnv };
  process.argv = savedArgv;
  fs.rmSync(state.userDataDir, { recursive: true, force: true });
});

describe("needsFallback", () => {
  it("is false on an X11 session, where globalShortcut grabs the key itself", async () => {
    const m = await load({ session: "x11", desktop: "KDE" });
    expect(m.needsFallback()).toBe(false);
  });

  it.each(["KDE", "GNOME", "sway", "Hyprland", ""])(
    "is true on a Wayland session under XWayland, whatever the compositor (%s)",
    async (desktop) => {
      const m = await load(wayland(desktop));
      expect(m.needsFallback()).toBe(true);
    }
  );

  it("is false on a forced native-Wayland run, where the portal is live again", async () => {
    // Not re-execed => no --ozone-platform=x11 => Electron is a real Wayland client.
    const m = await load({ session: "wayland", desktop: "KDE", xwayland: false });
    expect(m.needsFallback()).toBe(false);
  });
});

// The startup log line reports this, so that a Fedora/KDE report says which backend was live
// instead of leaving it to be inferred from symptoms, as it was the first time round.
describe("displayBackend", () => {
  it("reports plain x11 on an X11 session", async () => {
    expect((await load({ session: "x11" })).displayBackend()).toBe("x11");
  });

  it("marks the backend as forced when we re-execed onto XWayland", async () => {
    expect((await load(wayland("KDE"))).displayBackend()).toBe("x11 (forced)");
  });

  it("says wayland (native) when the escape hatch left us as a Wayland client", async () => {
    const m = await load({ session: "wayland", desktop: "KDE", xwayland: false });
    expect(m.displayBackend()).toBe("wayland (native)");
  });
});

describe("shortcutMode", () => {
  it("reports native on X11", async () => {
    const m = await load({ session: "x11" });
    expect(m.shortcutMode()).toBe("native");
  });

  it("reports manual on Wayland until the user opts into automation", async () => {
    const m = await load(wayland("KDE"));
    expect(m.shortcutMode()).toBe("manual");
  });

  it("reports gsettings on GNOME once the opt-in flag exists", async () => {
    const m = await load(wayland("GNOME"));
    fs.writeFileSync(path.join(state.userDataDir, ".wayland-gnome-configured"), "");
    expect(m.shortcutMode()).toBe("gsettings");
  });

  it("does not report gsettings on KDE even with a stale flag file", async () => {
    const m = await load(wayland("KDE"));
    fs.writeFileSync(path.join(state.userDataDir, ".wayland-gnome-configured"), "");
    expect(m.shortcutMode()).toBe("manual");
  });
});

describe("shortcutInfo", () => {
  it("offers the fifo command on X11 too, for keys the dropdown doesn't list", async () => {
    const m = await load({ session: "x11" });
    const info = m.shortcutInfo();
    expect(info.mode).toBe("native");
    expect(info.command).toBeTruthy();
    expect(info.canAutomate).toBe(false);
  });

  it("advertises automation only on GNOME, the one desktop we can configure", async () => {
    expect((await load(wayland("GNOME"))).shortcutInfo().canAutomate).toBe(true);
    expect((await load(wayland("KDE"))).shortcutInfo().canAutomate).toBe(false);
    expect((await load(wayland("sway"))).shortcutInfo().canAutomate).toBe(false);
  });
});

describe("shortcutProblem", () => {
  it("is null on X11, so the setup window stays shut", async () => {
    const m = await load({ session: "x11" });
    expect(m.shortcutProblem()).toBeNull();
  });

  it("carries the command to bind, in the setup window's problem shape", async () => {
    const m = await load(wayland("KDE"));
    const p = m.shortcutProblem();
    expect(p.code).toBe("shortcut");
    expect(p.title).toBeTruthy();
    expect(p.detail).toBeTruthy();
    expect(p.commands).toEqual([m.toggleCommand()]);
  });

  it("names the right settings path per desktop", async () => {
    expect((await load(wayland("KDE"))).shortcutProblem().note).toContain("System Settings");
    expect((await load(wayland("GNOME"))).shortcutProblem().note).toContain("Custom Shortcuts");
    // An unknown compositor still gets something actionable rather than nothing.
    expect((await load(wayland("sway"))).shortcutProblem().note).toContain("custom shortcuts");
  });

  it("tells the user what still works in the meantime", async () => {
    const p = (await load(wayland("KDE"))).shortcutProblem();
    expect(p.note).toContain("tray icon");
  });
});

// A button that opens the desktop's own shortcut editor, rather than describing a menu path. The
// binary has to actually exist, or the button would do nothing — so on this machine most desktops
// resolve to null, and the assertions are about the shape of the decision, not a fixed command.
describe("shortcutSettingsCommand", () => {
  it("offers nothing for a desktop we don't recognise", async () => {
    const m = await load(wayland("some-unknown-compositor"));
    expect(m.shortcutSettingsCommand()).toBeNull();
  });

  it("picks a command from the matching desktop's candidates, or nothing if none is installed", async () => {
    for (const [desktop, expectedBinary] of [
      ["KDE", /systemsettings|kcmshell/],
      ["GNOME", /gnome-control-center/],
      ["XFCE", /xfce4-keyboard-settings/],
    ] as const) {
      const cmd = (await load(wayland(desktop))).shortcutSettingsCommand();
      if (cmd !== null) expect(cmd).toMatch(expectedBinary);
    }
  });

  it("is reported alongside the shortcut command, so the UI can render both", async () => {
    const info = (await load(wayland("KDE"))).shortcutInfo();
    expect(info).toHaveProperty("settingsCommand");
    const problem = (await load(wayland("KDE"))).shortcutProblem();
    expect(problem).toHaveProperty("settingsCommand");
  });
});

describe("electronToXkb", () => {
  it.each([
    ["Ctrl+Alt+Space", "<Control><Alt>space"],
    ["Shift+Space", "<Shift>space"],
    ["Ctrl+Shift+Insert", "<Control><Shift>insert"],
    ["Alt+F12", "<Alt>f12"],
    ["Super+D", "<Super>d"],
  ])("converts %s to %s", async (accelerator, expected) => {
    const m = await load({ session: "x11" });
    expect(m._internal.electronToXkb(accelerator)).toBe(expected);
  });

  it("handles a bare key with no modifiers", async () => {
    const m = await load({ session: "x11" });
    expect(m._internal.electronToXkb("F12")).toBe("f12");
  });
});

describe("check", () => {
  it("does nothing when the user never opted into GNOME automation", async () => {
    const m = await load(wayland("GNOME"));
    // No flag file: must not shell out to gsettings, and must not throw.
    expect(() => m.check("Ctrl+Alt+Space")).not.toThrow();
    expect(fs.existsSync(path.join(state.userDataDir, ".wayland-gnome-configured"))).toBe(false);
  });
});
