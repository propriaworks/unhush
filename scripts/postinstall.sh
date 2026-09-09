#!/bin/bash
# Add unhush to PATH via a symlink in /usr/local/bin
ln -sf /opt/Unhush/unhush /usr/local/bin/unhush

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
