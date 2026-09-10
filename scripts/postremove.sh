#!/bin/bash
# rpm runs this scriptlet (%postun) on UPGRADES too, and it does so *after* the new package's
# %post has already written the udev rule -- so without this guard an `rpm -U` would delete the
# rule the upgrade just installed. rpm passes the number of remaining packages ("0" = final
# removal); dpkg passes remove/purge/upgrade; pacman's post_remove passes nothing.
case "${1-}" in 0|remove|purge|"") ;; *) exit 0 ;; esac

# Stop any instance still running. Uninstalling out from under a live app leaves it running from a
# deleted binary: tray icon still there, hotkey still firing, ydotoold child still holding
# /dev/uinput, FIFO still in $XDG_RUNTIME_DIR -- and its paste path already half-broken, since the
# udev rule below is about to go. Only reached on final removal (the guard above), never on an
# upgrade, where killing the user's running session would be its own bug.
#
# Instances are identified by /proc/PID/exe -- the kernel's own record of the running binary --
# never by process name or command line, so this cannot match an unrelated process that merely
# mentions "unhush". Every packager here unlinks the payload before running its post-removal
# script (rpm %postun, dpkg postrm, pacman post_remove), so by then the link reads "... (deleted)";
# match the plain form too, for a stop invoked while the files are still in place.
# /opt/Unhush is electron-builder's install prefix, derived from productName in package.json.
app=/opt/Unhush/unhush

# One find rather than a readlink per process: forking for each of a few hundred /proc entries and
# repeating that each poll measured ~2s per scan on the dev box -- far too slow for a scriptlet.
unhush_pids() {
  find /proc -mindepth 2 -maxdepth 2 -name exe \
    \( -lname "$app" -o -lname "$app (deleted)" \) -printf '%h\n' 2>/dev/null |
    sed 's#^/proc/##'
}

pids=$(unhush_pids)
if [ -n "$pids" ]; then
  # SIGTERM first: Electron turns it into an ordinary app quit, so will-quit still runs and the app
  # removes its own FIFO and stops its ydotoold child. Give that a few seconds before insisting.
  kill $pids 2>/dev/null
  for _ in $(seq 10); do
    [ -n "$(unhush_pids)" ] || break
    sleep 0.5
  done
  remaining=$(unhush_pids)
  if [ -n "$remaining" ]; then
    kill -9 $remaining 2>/dev/null
  fi
  # Left behind only by an instance that had to be killed outright -- harmless (tmpfs, and nothing
  # remains that could write to it), but no reason to leave it lying about. Exact names only.
  rm -f /run/user/*/unhush.fifo /tmp/unhush-*.fifo
fi

rm -f /usr/local/bin/unhush
rm -f /usr/local/bin/unhush-toggle
rm -f /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules 2>/dev/null || true

# No ydotoold teardown needed: Unhush runs its own daemon as a child process (see
# electron/ydotool.cjs), so it exits with the app -- nothing is installed or enabled system-wide.
#
# Nor is there a global shortcut to unregister. Any desktop-environment binding is the user's own
# config, in their home directory, which a root scriptlet can't reach for every user anyway -- and
# with the binding gone the leftover shortcut simply runs a command that no longer exists. The one
# binding Unhush creates itself is the optional GNOME one, removable from Settings while the app is
# still installed (see removeGnomeShortcut in electron/waylandShortcut.cjs).
