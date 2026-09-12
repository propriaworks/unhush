#!/bin/bash
# rpm runs this scriptlet (%postun) on UPGRADES too, and it does so *after* the new package's
# %post has already written the udev rule -- so without this guard an `rpm -U` would delete the
# rule the upgrade just installed. rpm passes the number of remaining packages ("0" = final
# removal); dpkg passes remove/purge/upgrade; pacman's post_remove passes nothing.
case "${1-}" in 0|remove|purge|"") final=1 ;; *) final=0 ;; esac

# An upgrade has nothing to do here: the new package's postinstall.sh has already run and decided
# what any running instance becomes (restarted in place, or left alone) -- see that file.
[ "$final" = 0 ] && exit 0

# --- Stop any running instance ------------------------------------------------------------------
#
# This used to be preremove.sh's job, run *before* the payload was unlinked, because Chromium's own
# "unexpected child death" respawn logic once tried to exec a just-deleted binary+libraries when
# signalled mid-transaction. That was traced to signalling child processes directly rather than
# only the root Electron process -- with the roots()-only scoping below, an orderly app.quit()
# shutdown doesn't exec or load anything new from disk, so killing *after* the payload is already
# gone (which is the case by the time this runs) is believed safe too, and preremove.sh is gone.

# Root pids only: a forked/zygote child inherits its parent's cgroup and Chromium never moves its
# own children to a different one, so callers only ever need to signal these. Identified by
# /proc/PID/exe -- the kernel's own record of the running binary -- never by process name or
# command line, so this can't match an unrelated process that merely mentions "unhush". The
# "(deleted)" form is the only one that can match here, since /opt/Unhush is already gone.
unhush_pids() {
  find /proc -mindepth 2 -maxdepth 2 -name exe \
    \( -lname /opt/Unhush/unhush -o -lname "/opt/Unhush/unhush (deleted)" \) -printf '%h\n' 2>/dev/null |
    sed 's#^/proc/##'
}

# Chromium is a process tree -- browser, two zygotes, GPU, renderers, utilities -- and every one
# of them has the same /proc/PID/exe, so unhush_pids returns the whole tree. Only the roots may
# be signalled: a process whose parent is not itself Unhush.
unhush_roots() {
  # Unquoted, so the newline-separated list collapses to a single space-separated line -- the
  # membership test below is a substring match and needs " $ppid " to be literally that.
  all=" $(echo $1) "
  for pid in $1; do
    # /proc/PID/stat's second field is the comm in parentheses and may itself contain spaces or
    # a ")", so read the fields *after* the last ")": state, then ppid.
    rest=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null) || continue
    ppid=$(printf '%s' "$rest" | cut -d' ' -f2)
    case "$all" in
      *" $ppid "*) ;;                  # parent is Unhush too: a child, left to the browser
      *) printf '%s\n' "$pid" ;;
    esac
  done
}

# SIGTERM (Electron turns it into an ordinary app quit) -> wait up to 5s -> SIGKILL stragglers.
unhush_kill_roots() {
  pids="$1"
  [ -n "$pids" ] || return 0
  kill $pids 2>/dev/null
  for _ in $(seq 10); do
    alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -n "$alive" ] || return 0
    sleep 0.5
  done
  kill -9 $alive 2>/dev/null
}

unhush_raw_pids_for_uid() {
  uid="$1"
  unhush_pids | while IFS= read -r pid; do
    [ "$(stat -c '%u' "/proc/$pid" 2>/dev/null)" = "$uid" ] && printf '%s\n' "$pid"
  done
}

# Per-uid enumeration (not just "whoever's running the uninstall"): a root scriptlet has no
# session of its own, and multi-seat machines can have more than one live at once.
# /run/user/<uid>/systemd/private's existence is a direct, cheap test for "does this uid have a
# running user manager." XDG_RUNTIME_DIR is exported explicitly since a root-invoked runuser
# doesn't reliably reproduce it.
for socket in /run/user/*/systemd/private; do
  [ -S "$socket" ] || continue
  uid=${socket#/run/user/}; uid=${uid%%/*}
  user=$(getent passwd "$uid" | cut -d: -f1) || continue
  [ -n "$user" ] || continue
  run_as() { runuser -u "$user" -- env "XDG_RUNTIME_DIR=/run/user/$uid" "$@"; }

  # Stops it if active, un-enables regardless -- the unit file is still present here (needed to
  # resolve [Install] and remove the right symlink; it's deleted a few lines below).
  run_as systemctl --user disable --now --no-block unhush.service >/dev/null 2>&1 || true
  # disable --now only touches the unit -- also sweep for a raw instance running independent of
  # it (never systemd-managed, or drifted since -- see startup self-heal, electron/main.cjs).
  raw_pids=$(unhush_raw_pids_for_uid "$uid")
  [ -n "$raw_pids" ] && unhush_kill_roots "$(unhush_roots "$raw_pids")"
done

rm -f /usr/lib/systemd/user/unhush.service

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
#
# ~/.local/share/applications/com.propriaworks.unhush.desktop (the "Start at login" desktop-icon
# override, see electron/main.cjs' syncDesktopOverride) is left behind too, for the same
# every-user's-home-is-unreachable reason -- it's inert once the unit above is gone, since
# `systemctl --user start` on a missing unit just fails cleanly.
