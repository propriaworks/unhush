#!/bin/bash
# Grant the active (logged-in) user write access to /dev/uinput, required by ydotool.
# TAG+="uaccess" is the modern systemd/logind approach: no group membership or re-login needed.
# GROUP/MODE provide a fallback for elogind-based non-systemd desktops.
echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  > /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules
udevadm trigger --name-match=uinput 2>/dev/null || udevadm trigger
