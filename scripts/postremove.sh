#!/bin/bash
rm -f /usr/local/bin/unhush
rm -f /etc/udev/rules.d/80-uinput.rules
udevadm control --reload-rules 2>/dev/null || true
