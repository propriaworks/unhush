// Which display server this process is actually talking to.
//
// DISPLAY-with-no-WAYLAND_DISPLAY, rather than XDG_SESSION_TYPE, for two reasons. That variable
// is unset often enough to be unreliable (a bare startx, some display managers), and under
// Wayland DISPLAY is usually set as well -- by XWayland -- so testing DISPLAY alone would claim
// X11 on most Wayland desktops. Testing the pair is what separates "a real X server owns the
// screen" from "an X server exists for compatibility".
//
// Not cached: a process's environment is fixed at exec, so the answer cannot change under a
// running app, but leaving it live keeps the function testable without module reloading.

/** True on a real X11 session; false under Wayland, with or without XWayland. */
function isX11() {
  return !!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

module.exports = { isX11 };
