// @vitest-environment node
//
// This module decides which of three mechanisms owns the dictation hotkey -- Chromium's own X11
// grab, the XDG GlobalShortcuts portal, or the user's own desktop binding -- and, when the portal
// path drops out mid-session, how hard to try to get it back. None of that can be exercised on the
// dev box (X11/Cinnamon, no GlobalShortcuts backend), which is exactly why it is tested here.
//
// The portal client is injected through init(): vitest's vi.mock cannot reach a require() inside a
// .cjs module (measured -- see the note in waylandShortcut.cjs), and without a stand-in every case
// below would open a real D-Bus connection and answer differently per machine.
//
// Session type and argv are read once at module load, so each case loads the module afresh.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const savedEnv = { ...process.env };
const savedArgv = process.argv;

type StartResult =
  | { ok: true; triggerDescription?: string }
  | { ok: false; reason: "unavailable" | "denied" | "error"; error?: string };

// Stands in for portalShortcuts.cjs. `results` is consumed one call at a time (the last entry
// repeats), so a case can say "fail, fail, then succeed" and let the retry loop drive it.
function fakePortal(results: StartResult[]) {
  const calls: any[] = [];
  return {
    calls,
    stopped: 0,
    configured: 0,
    // What ListShortcuts would report now; set it to simulate an edit made in the desktop's editor.
    listTrigger: "Ctrl+Alt+Space" as string | null,
    listOk: true,
    fire: () => calls[calls.length - 1].onActivated(),
    drop: () => calls[calls.length - 1].onDisconnected(),
    change: (trigger: string) => calls[calls.length - 1].onShortcutsChanged(trigger),
    init() {},
    async start(opts: any) {
      calls.push(opts);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    async list() {
      if (!this.listOk) return { ok: false, reason: "error", error: "no session" };
      return { ok: true, shortcuts: [["toggle-recording", { trigger_description: this.listTrigger }]] };
    },
    stop() { this.stopped += 1; },
    // configureFails: answer the first call the way a portal with a dead session does.
    configureFails: false,
    async configure() {
      this.configured += 1;
      if (this.configureFails) {
        this.configureFails = false;
        return { ok: false, reason: "error", error: "org.freedesktop.DBus.Error.AccessDenied: Invalid session" };
      }
      return { ok: true };
    },
  };
}

type Case = { session?: string; xwayland?: boolean; results?: StartResult[] };

async function load({ session, xwayland, results = [{ ok: true, triggerDescription: "Ctrl+Alt+Space" }] }: Case = {}) {
  vi.resetModules();
  process.env.XDG_SESSION_TYPE = session ?? "x11";
  // The re-exec guard in main.cjs is what puts this on our command line.
  process.argv = ["/opt/Unhush/unhush", ...(xwayland ? ["--ozone-platform=x11"] : [])];
  const mod: any = await import("./waylandShortcut.cjs");
  const m = mod.default ?? mod;
  const portal = fakePortal(results);
  m.init(() => {}, portal);
  return { m, portal };
}

// A Wayland session as Unhush actually runs on one: re-execed onto XWayland.
const wayland = (results?: StartResult[]): Case => ({ session: "wayland", xwayland: true, results });

beforeEach(() => { vi.useRealTimers(); });

afterEach(() => {
  process.env = { ...savedEnv };
  process.argv = savedArgv;
  vi.useRealTimers();
});

// The startup log line reports this, so that a Fedora/KDE report says which backend was live
// instead of leaving it to be inferred from symptoms, as it was the first time round.
describe("displayBackend", () => {
  it("reports plain x11 on an X11 session", async () => {
    expect((await load({ session: "x11" })).m.displayBackend()).toBe("x11");
  });

  it("marks the backend as forced when we re-execed onto XWayland", async () => {
    expect((await load(wayland())).m.displayBackend()).toBe("x11 (forced)");
  });

  it("says wayland (native) when the escape hatch left us as a Wayland client", async () => {
    const { m } = await load({ session: "wayland", xwayland: false });
    expect(m.displayBackend()).toBe("wayland (native)");
  });
});

describe("usesPortal", () => {
  it("is false on X11, where Chromium grabs the key itself", async () => {
    expect((await load({ session: "x11" })).m.usesPortal()).toBe(false);
  });

  // The portal is reached over D-Bus, which does not care which display protocol Chromium speaks.
  it.each([true, false])("is true on any Wayland session (xwayland=%s)", async (xwayland) => {
    expect((await load({ session: "wayland", xwayland })).m.usesPortal()).toBe(true);
  });
});

describe("electronToXdgTrigger", () => {
  it.each([
    ["Ctrl+Alt+Space", "CTRL+ALT+space"],
    ["Ctrl+Alt+\\", "CTRL+ALT+backslash"],   // the option that replaced Shift+Space
    ["Ctrl+Shift+Insert", "CTRL+SHIFT+Insert"],
    ["Alt+F12", "ALT+F12"],                  // F-keys keep their capital F; "space" must not
    ["Super+D", "SUPER+d"],
    ["Shift+Space", "SHIFT+space"],          // a value stored by an older version
    ["F13", "F13"],                          // no modifiers at all
  ])("converts %s to %s", async (accelerator, expected) => {
    const { m } = await load();
    expect(m._internal.electronToXdgTrigger(accelerator)).toBe(expected);
  });
});

describe("startPortal", () => {
  it("does nothing at all on X11", async () => {
    const { m, portal } = await load({ session: "x11" });
    await m.startPortal("Ctrl+Alt+Space", () => {});
    expect(portal.calls).toHaveLength(0);
    expect(m.shortcutMode()).toBe("native");
  });

  it("binds one stable id with the user's key as the preferred trigger", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Alt+F12", () => {});
    expect(portal.calls[0]).toMatchObject({ id: "toggle-recording", preferredTrigger: "ALT+F12" });
    expect(m.shortcutMode()).toBe("portal");
    expect(m.shortcutInfo()).toMatchObject({ trigger: "Ctrl+Alt+Space", canConfigure: true });
  });

  // preferred_trigger is honoured on the first bind only, so a second call has nothing to offer --
  // and re-binding for every accelerator change is what broke Electron's own portal path.
  it("is idempotent: a later accelerator change does not rebind", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    await m.startPortal("Alt+F12", () => {});
    expect(portal.calls).toHaveLength(1);
  });

  it("routes Activated to the callback it was given", async () => {
    const { m, portal } = await load(wayland());
    let fired = 0;
    await m.startPortal("Ctrl+Alt+Space", () => { fired += 1; });
    portal.fire();
    expect(fired).toBe(1);
  });

  it("keeps portal mode when every trigger has been unchecked, reporting no key", async () => {
    // The bind succeeds and the shortcut is registered; it simply cannot fire. Settings needs to
    // say that rather than show a key that does nothing.
    const { m } = await load(wayland([{ ok: true }]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    expect(m.shortcutMode()).toBe("portal");
    expect(m.shortcutInfo().trigger).toBe("");
  });
});

describe("a cold failure", () => {
  it("falls back to the manual command when there is no GlobalShortcuts backend", async () => {
    const { m } = await load(wayland([{ ok: false, reason: "unavailable" }]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    expect(m.shortcutMode()).toBe("manual");
    const p = m.shortcutProblem();
    expect(p.code).toBe("shortcut");
    expect(p.commands).toEqual([m.toggleCommand()]);
    expect(p.note).toContain("tray icon");
    // The per-desktop settings-binary table is gone; nothing should still advertise one.
    expect(p.settingsCommand).toBeUndefined();
  });

  // Retrying a refusal would re-raise the consent dialog the user just dismissed.
  it("never retries a denial", async () => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland([{ ok: false, reason: "denied" }]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    await vi.advanceTimersByTimeAsync(120000);
    expect(portal.calls).toHaveLength(1);
    expect(m.shortcutMode()).toBe("manual");
  });

  it("resolves settled() either way, so the setup window isn't left waiting", async () => {
    const { m } = await load(wayland([{ ok: false, reason: "error", error: "boom" }]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    await expect(m.settled()).resolves.toBeUndefined();
  });

  it("is already settled on X11, where no attempt is ever made", async () => {
    const { m } = await load({ session: "x11" });
    await expect(m.settled()).resolves.toBeUndefined();
  });
});

describe("a mid-session drop", () => {
  it("rebinds on the first backoff step", async () => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.drop();
    expect(portal.calls).toHaveLength(1);        // nothing immediate
    await vi.advanceTimersByTimeAsync(1000);
    expect(portal.calls).toHaveLength(2);
    expect(m.shortcutMode()).toBe("portal");
  });

  // The same reasons that mean "this desktop can't do it" when cold mean "not back yet" here --
  // including denied, since permission is already on record.
  it.each(["unavailable", "error", "denied"] as const)("retries a %s answer", async (reason) => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland([
      { ok: true, triggerDescription: "Ctrl+Alt+Space" },
      { ok: false, reason },
      { ok: true, triggerDescription: "Ctrl+Alt+Space" },
    ]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.drop();
    await vi.advanceTimersByTimeAsync(1000);     // first retry: fails
    expect(portal.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);     // second: succeeds
    expect(portal.calls).toHaveLength(3);
    expect(m.shortcutMode()).toBe("portal");
  });

  // Telling the user to go bind a key by hand, seconds before the binding comes back on its own,
  // would be worse than the outage.
  it("does not switch to manual while retries are still pending", async () => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland([
      { ok: true, triggerDescription: "Ctrl+Alt+Space" },
      { ok: false, reason: "unavailable" },
    ]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.drop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.shortcutMode()).toBe("portal");
    expect(m.shortcutProblem()).toBeNull();
  });

  it("gives up after the whole backoff, then reports manual", async () => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland([
      { ok: true, triggerDescription: "Ctrl+Alt+Space" },
      { ok: false, reason: "unavailable" },
    ]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.drop();
    const total = m._internal.RETRY_DELAYS_MS.reduce((a: number, b: number) => a + b, 0);
    await vi.advanceTimersByTimeAsync(total + 1000);
    expect(portal.calls).toHaveLength(1 + m._internal.RETRY_DELAYS_MS.length);
    expect(m.shortcutMode()).toBe("manual");
    expect(m.shortcutProblem()).not.toBeNull();
  });

  it("stops retrying once we are quitting", async () => {
    vi.useFakeTimers();
    const { m, portal } = await load(wayland([
      { ok: true, triggerDescription: "Ctrl+Alt+Space" },
      { ok: false, reason: "unavailable" },
    ]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.drop();
    m.stopPortal();
    await vi.advanceTimersByTimeAsync(120000);
    expect(portal.calls).toHaveLength(1);
    expect(portal.stopped).toBe(1);
  });
});

// The key can change under us at any time: the portal honours our preferred trigger once, and from
// then on the desktop's own editor owns it. Showing the trigger we were handed at startup for the
// rest of the run would mean the UI ends up lying about which key works.
describe("keeping the displayed trigger current", () => {
  it("follows a ShortcutsChanged signal", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.change("Meta+D");
    expect(m.shortcutInfo().trigger).toBe("Meta+D");
  });

  it("tells the caller, so the tray menu can follow too", async () => {
    const { m, portal } = await load(wayland());
    let changes = 0;
    await m.startPortal("Ctrl+Alt+Space", () => {}, () => { changes += 1; });
    portal.change("Meta+D");
    expect(changes).toBe(1);
  });

  it("reports an empty trigger, which means every key was switched off", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.change("");
    expect(m.shortcutInfo().trigger).toBe("");
  });

  it("re-reads from the portal on refresh(), for a UI opening later", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.listTrigger = "Ctrl+Alt+Y";
    await m.refresh();
    expect(m.shortcutInfo().trigger).toBe("Ctrl+Alt+Y");
  });

  it("keeps the last known trigger when the portal can't answer", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.listOk = false;
    await m.refresh();
    expect(m.shortcutInfo().trigger).toBe("Ctrl+Alt+Space");
  });

  it("does nothing on the manual path, where there is no session to ask", async () => {
    const { m } = await load(wayland([{ ok: false, reason: "unavailable" }]));
    await m.startPortal("Ctrl+Alt+Space", () => {});
    await expect(m.refresh()).resolves.toBeUndefined();
    expect(m.shortcutMode()).toBe("manual");
  });
});

describe("shortcutInfo", () => {
  it("offers the fifo command on X11 too, for keys the dropdown doesn't list", async () => {
    const { m } = await load({ session: "x11" });
    expect(m.shortcutInfo()).toMatchObject({ mode: "native", canConfigure: false });
    expect(m.shortcutInfo().command).toBeTruthy();
  });

  it("offers the desktop's editor only on the portal path", async () => {
    const bound = await load(wayland());
    await bound.m.startPortal("Ctrl+Alt+Space", () => {});
    expect(bound.m.shortcutInfo().canConfigure).toBe(true);

    const unbound = await load(wayland([{ ok: false, reason: "unavailable" }]));
    await unbound.m.startPortal("Ctrl+Alt+Space", () => {});
    expect(unbound.m.shortcutInfo().canConfigure).toBe(false);
  });
});

describe("shortcutProblem", () => {
  it("is null on X11, so the setup window stays shut", async () => {
    const { m } = await load({ session: "x11" });
    expect(m.shortcutProblem()).toBeNull();
  });

  it("is null once the portal has bound the key for us", async () => {
    const { m } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    expect(m.shortcutProblem()).toBeNull();
  });
});

describe("configure", () => {
  it("hands off to the portal's own editor", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    await m.configure();
    expect(portal.configured).toBe(1);
  });

  // Measured on Fedora/KDE: after `systemctl --user restart xdg-desktop-portal`, ConfigureShortcuts
  // answers "AccessDenied: Invalid session" -- the portal takes every session down with it.
  it("rebinds and retries when the session died under it", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.configureFails = true;
    const result = await m.configure();
    expect(result).toMatchObject({ ok: true });
    expect(portal.calls).toHaveLength(2);   // rebound before the second attempt
    expect(portal.configured).toBe(2);
  });

  it("does not rebind for an unrelated failure", async () => {
    const { m, portal } = await load(wayland());
    await m.startPortal("Ctrl+Alt+Space", () => {});
    portal.configure = async () => ({ ok: false, reason: "error", error: "no editor installed" });
    await m.configure();
    expect(portal.calls).toHaveLength(1);
  });
});
