#!/bin/bash
# rpm runs this scriptlet (%postun) on UPGRADES too, and it does so *after* the new package's
# %post has already written the udev rule -- so without this guard an `rpm -U` would delete the
# rule the upgrade just installed. rpm passes the number of remaining packages ("0" = final
# removal); dpkg passes remove/purge/upgrade; pacman's post_remove passes nothing.
case "${1-}" in 0|remove|purge|"") ;; *) exit 0 ;; esac

rm -f /usr/local/bin/unhush
rm -f /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules 2>/dev/null || true

# No ydotoold teardown needed: Unhush runs its own daemon as a child process (see
# electron/ydotool.cjs), so it exits with the app -- nothing is installed or enabled system-wide.
