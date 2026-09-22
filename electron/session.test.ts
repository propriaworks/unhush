// @vitest-environment node
//
// The X11 test decides whether xprop is used to find the active window, whether there is a window
// manager to wait for, and whether the selection diagnostics run. Getting it wrong under Wayland
// is the expensive direction -- DISPLAY is usually set there too, by XWayland -- so the Wayland
// cases are covered explicitly.

import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error - plain CommonJS module, no type declarations
import session from "./session.cjs";

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("isX11", () => {
  it("accepts a plain X11 session", () => {
    process.env.DISPLAY = ":0";
    delete process.env.WAYLAND_DISPLAY;
    expect(session.isX11()).toBe(true);
  });

  // The one that matters. Under Wayland, DISPLAY is usually set too because XWayland is running,
  // so testing DISPLAY alone would wrongly claim X11 on most Wayland desktops.
  it("rejects Wayland even when XWayland has set DISPLAY", () => {
    process.env.DISPLAY = ":0";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(session.isX11()).toBe(false);
  });

  it("rejects Wayland with no XWayland", () => {
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(session.isX11()).toBe(false);
  });

  // main.cjs exits at startup when neither is set, so this is unreachable in practice -- but the
  // answer must still be "no", never a crash.
  it("rejects a session with no display at all", () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(session.isX11()).toBe(false);
  });

  // Deliberately not consulted: it is unset under a bare startx, and a stale or wrong value must
  // not override the display variables the session actually set.
  it("ignores XDG_SESSION_TYPE", () => {
    process.env.DISPLAY = ":0";
    delete process.env.WAYLAND_DISPLAY;
    process.env.XDG_SESSION_TYPE = "wayland";
    expect(session.isX11()).toBe(true);
  });
});
