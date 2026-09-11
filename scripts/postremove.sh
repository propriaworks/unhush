#!/bin/bash
# rpm runs this scriptlet (%postun) on UPGRADES too, and it does so *after* the new package's
# %post has already written the udev rule -- so without this guard an `rpm -U` would delete the
# rule the upgrade just installed. rpm passes the number of remaining packages ("0" = final
# removal); dpkg passes remove/purge/upgrade; pacman's post_remove passes nothing.
case "${1-}" in 0|remove|purge|"") final=1 ;; *) final=0 ;; esac

# An upgrade has nothing to do here: the new package's %post has already run, and the app was
# stopped (not restarted -- see scripts/preremove.sh) before the payload was swapped.
[ "$final" = 0 ] && exit 0

# Stopping the app is scripts/preremove.sh's job: it runs before the payload is unlinked, so the
# app can shut down with its own binary still present. By the time this runs, /opt/Unhush is gone.
#
# Left behind by an instance that was killed outright, or by an earlier crash -- harmless (tmpfs,
# and nothing remains that could write to it), but no reason to leave it lying about. Exact names
# only.
rm -f /run/user/*/unhush.fifo /tmp/unhush-*.fifo

rm -f /usr/local/bin/unhush
rm -f /usr/local/bin/unhush-toggle
rm -f /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules 2>/dev/null || true

# No ydotoold teardown needed: Unhush runs its own daemon as a child process (see
# electron/ydotool.cjs), so it exits with the app -- nothing is installed or enabled system-wide.
#
# The global shortcut is not ours to remove either. On X11 the grab dies with the process. On
# Wayland the binding lives in the desktop's own shortcut settings, put there through the
# GlobalShortcuts portal -- which has no unbind at all, by design, so not even the running app can
# withdraw it; it is per-user config a root scriptlet could not reach for every user regardless.
# A leftover entry is inert (it runs a command that no longer exists) and the user can delete it in
# their desktop's shortcut settings. Same for any custom shortcut they bound to unhush-toggle.
