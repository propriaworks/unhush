#!/bin/bash
# Add unhush to PATH via a symlink in /usr/local/bin
ln -sf /opt/Unhush/unhush /usr/local/bin/unhush

# Helper for desktop-environment keyboard shortcuts. On Wayland we run under XWayland, where the
# compositor won't deliver X11 key grabs to us, so the DE owns the binding and runs this; it writes
# one line into the command fifo of the running app (see electron/commandFifo.cjs). Useful on X11
# too, for binding keys the Settings dropdown doesn't offer.
cat > /usr/local/bin/unhush-toggle <<'EOF'
#!/bin/sh
# Toggle Unhush recording. Managed by the unhush package -- reinstalling overwrites this.
FIFO="${XDG_RUNTIME_DIR:-/tmp}/unhush.fifo"
# `timeout`: writing to a fifo with no reader blocks forever, which would wedge the desktop
# shortcut if Unhush died without cleaning up. Falling through then launches the app instead.
if [ -p "$FIFO" ] && timeout 0.5 sh -c "printf 'toggle\n' > \"$FIFO\""; then
  exit 0
fi
exec /usr/local/bin/unhush
EOF
chmod 755 /usr/local/bin/unhush-toggle

# Grant the active (logged-in) user write access to /dev/uinput, required by ydotool.
# TAG+="uaccess" is the modern systemd/logind approach: no group membership or re-login needed.
# GROUP/MODE provide a fallback for elogind-based non-systemd desktops.
#
# Fedora/Arch/Debian's own ydotool package ships /usr/lib/udev/rules.d/80-uinput.rules. Ours has
# the same basename in /etc, which takes precedence, so this deliberately masks theirs.
echo -e '## DO NOT EDIT -- managed by unhush app\n## enables writing to uinput for ydotool\nKERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  > /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules
udevadm trigger --name-match=uinput 2>/dev/null || udevadm trigger --subsystem-match=misc
# `udevadm trigger` only queues the uevents; logind applies the uaccess ACL asynchronously.
# Settle before returning, or Unhush might start before /dev/uinput is writable, tripping
# its setup warning unnecessarily.
udevadm settle --timeout=10 || true
