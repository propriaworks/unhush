#!/bin/bash
# /usr/local/bin/unhush -- on PATH, and every "start Unhush" entry point (the desktop icon,
# unhush-toggle's fallback, a user's own DE-autostart entry, someone typing `unhush`) goes through
# it rather than the raw binary. All of those paths get the same benefit: prefer systemd (an instance
# it starts is tracked the same way -- stoppable, restartable, auto-restarted on crash -- no matter
# which entry point started it) but fall back to launching the binary directly if that fails for any
# reason -- no --user manager, a broken unit, or no unit installed at all (AppImage/dev), or no systemd.
#
# NOTE that unhush.service's own ExecStart= must point to the actual executable, not here.
cat > /usr/local/bin/unhush <<'EOF'
#!/bin/sh
# Launch Unhush. Managed by the unhush package -- reinstalling overwrites this.
if systemctl --user start unhush.service 2>/dev/null; then
  # Unlike the exec fallback below, the app that just started is a separate, systemd-managed
  # process -- nothing of ours stays attached to this terminal for main.cjs's own startup banner
  # to print into, so this is the one launch path that has to speak up for it itself.
  [ -t 2 ] && echo "Unhush started — look for the tray icon." >&2
  exit 0
fi
exec /opt/Unhush/unhush --ozone-platform=x11 "$@"
EOF
chmod 755 /usr/local/bin/unhush

# electron-builder hardcodes the installed .desktop's Exec= to the raw binary -- it refuses to let
# this project override that at build time ("Please specify executable name as linux.executableName
# instead") -- so the icon is pointed at the wrapper above instead, here, once, system-wide.
#
# This used to be done per-user instead, at app runtime (main.cjs writing a
# ~/.local/share/applications override, since electron-builder's own installed copy isn't writable
# by an unprivileged process) -- needed back when the corrected line varied by a per-user setting
# ("Start at login"). It no longer does: every user gets the same wrapper either way now, so one
# fix here, to the file this package itself just installed, covers everyone permanently. Only
# matches the exact line electron-builder wrote, so running this again on an upgrade, against
# an already-patched file, is a harmless no-op.
sed -i 's|^Exec=/opt/Unhush/unhush|Exec=/usr/local/bin/unhush|' \
  /usr/share/applications/com.propriaworks.unhush.desktop

# Helper for desktop-environment keyboard shortcuts. On Wayland we run under XWayland, where the
# compositor won't deliver X11 key grabs to us, so the DE owns the binding and runs this; it writes
# one line into the command fifo of the running app (see electron/commandFifo.cjs). Useful on X11
# too, for binding keys the Settings dropdown doesn't offer.
cat > /usr/local/bin/unhush-toggle <<'EOF'
#!/bin/sh
# Toggle Unhush recording. Managed by the unhush package -- reinstalling overwrites this.
FIFO="${XDG_RUNTIME_DIR:-/tmp}/unhush.fifo"
# `timeout`: writing to a fifo with no reader blocks forever, which would wedge the desktop
# shortcut if Unhush died without cleaning up. Falling through means there's no reader (or no fifo
# at all) -- so Unhush isn't running. Launch it via /usr/local/bin/unhush.
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

# pacman only: fpm 1.17 never writes optdepend lines (its template reads a different attribute
# from the one --pacman-optional-depends fills; jordansissel/fpm#1619, still open, as is 1.18),
# so pacman can't list the optional packages itself
# and we say so here. Each line goes quiet once its tool is present. Drop this once fpm is fixed.
if command -v pacman >/dev/null 2>&1; then
  command -v pactl >/dev/null 2>&1 || echo "unhush: optional: 'pacman -S libpulse' lets Unhush lower other apps' audio while recording."
  command -v xprop >/dev/null 2>&1 || echo "unhush: optional: 'pacman -S xorg-xprop' shows the paste target in the tray (X11 only)."
fi

# systemd --user unit, shipped but disabled by default -- opted into via Settings -> "Start at
# login" (electron/main.cjs' set-autostart handler). Same unit name and ExecStart as the README's
# hand-rolled instructions, so anyone who already followed those is silently subsumed: identical
# file, no behavior change, and their next enable/disable goes through Settings instead.
#
# ExecStart= is the real binary, not /usr/local/bin/unhush to avoid circular invocation.
#
# Plain Type=simple (the default -- deliberately not specified): correct by construction now,
# because there is only ever one process for the app's whole life, on both session types.
# --ozone-platform=x11 is right here on ExecStart= -- a no-op on an X11 session (Electron already
# resolves to that ozone backend by default there) what's needed on Wayland to force XWayland.
#
# KillMode=mixed, not the control-group default: systemd's default sends SIGTERM to every process
# in the unit's cgroup at once on stop/restart -- the Chromium browser process *and* every zygote/
# GPU/renderer child simultaneously. The browser then sees a child die from a signal it didn't
# orchestrate itself, its own "unexpected child death" handling kicks in, and it crashes -- the
# exact same failure class the old preremove.sh's roots()-only scoping existed to avoid, just
# triggered by systemd's own kill behavior instead of a script signalling children directly. mixed
# sends SIGTERM to the main process alone (letting Chromium shut its own children down in order,
# same as an ordinary Quit) and reserves SIGKILL for whatever is still in the cgroup once the main
# process is gone -- observed, on a clean shutdown, to land in the same instant as the main process's
# own exit, not after a fresh wait: TimeoutStopSec= only bounds how long systemd waits *for the main
# process itself*, and once that's done it sweeps any remainder immediately rather than pausing again
# for it. A lingering zygote/GPU child getting SIGKILL'd this way is expected and harmless -- its
# parent's exit already closed the socket it blocks on (CLOEXEC), so it's already unwinding on its
# own; systemd's sweep just wins the race to actually reap it.
#
# WantedBy=default.target, and the login-time environment race that comes with it: a user unit
# pulled in by default.target starts when logind opens the PAM session, which can be *before*
# the Xsession.d scripts run, so the session's full environment -- notably the user's PATH --
# only arrives much later, at 95dbus_update-activation-env. So Unhush can start with a usable
# display but systemd's compiled-in PATH, and anything it looks up by name may resolve to a
# different binary than the one the user's shell would find. We now resolve binaries from
# PATH *and* the usual install directories rather than trusting PATH alone.
#   - WantedBy=graphical-session.target looks right but is not portable: Linux Mint
#     never activates that target, so the unit would simply never autostart there.
# If some future need really does call for a delayed or repeated start, a systemd *timer* unit
# (OnStartupSec=/OnUnitActiveSec=) is the mechanism to use, not a sleep in ExecStartPre.
mkdir -p /usr/lib/systemd/user
cat > /usr/lib/systemd/user/unhush.service <<'EOF'
[Unit]
Description=Unhush Voice Dictation
# The restarts below are for a login race, not for a crash loop: when the unit starts before
# the session exports DISPLAY, Unhush logs the reason and exits 1 immediately (a process can
# never see an environment exported after its own exec, so only a fresh start can pick it up).
# systemd's defaults are far too tight for that. Thirty tries, ten seconds apart, covers
# about five minutes of a slow login and still gives up eventually on a machine
# that has no display at all.
StartLimitIntervalSec=300
StartLimitBurst=30

[Service]
KillMode=mixed
ExecStart=/opt/Unhush/unhush --ozone-platform=x11
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# --- Upgrade-safe restart --------------------------------------------------------------------
#
# Package managers don't kill a running process during an upgrade -- they just replace files
# underneath it, which is safe for an already-mapped binary as long as nothing execs/loads
# something new mid-transaction. So there's no separate pre-deletion "kill" scriptlet: this is
# the one place, run once the new payload is stably in place, that decides what a running
# instance becomes, by checking reality (systemd tracking it? a raw instance running anyway?
# nothing at all?) rather than trying to out-guess dpkg's/rpm's/pacman's differing hook ordering.

# Root pids only: a forked/zygote child inherits its parent's cgroup and Chromium never moves its
# own children to a different one, so callers only ever need to signal these. Identified by
# /proc/PID/exe -- the kernel's own record of the running binary -- never by process name or
# command line, so this can't match an unrelated process that merely mentions "unhush". The
# "(deleted)" form appears once an upgrade has replaced the file under a still-running process.
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

# Per-uid enumeration (not just "whoever's running the installer"): a root scriptlet has no
# session of its own, and multi-seat machines can have more than one live at once.
# /run/user/<uid>/systemd/private's existence is a direct, cheap test for "does this uid have a
# running user manager," cheaper than shelling out to loginctl. XDG_RUNTIME_DIR is exported
# explicitly since a root-invoked runuser doesn't reliably reproduce it. --no-block throughout so
# a slow-to-quit instance can't hang the package manager's own transaction (never fatal, matching
# this file's existing `|| true` style).
#
# No fresh-install-vs-upgrade branch anywhere: on a fresh install, is-active is false and
# raw_pids is empty for every uid (nothing has ever run before), so the whole loop is a no-op --
# "nothing auto-starts on install" falls out for free.
for socket in /run/user/*/systemd/private; do
  [ -S "$socket" ] || continue
  # basename/dirname, not a bash %% expansion: rpm's spec-macro processor treats a literal "%" as
  # its own macro-escape character and collapses "%%" to a single "%" when fpm embeds this file's
  # text into the rpm %post scriptlet -- silently turning this into the wrong (shortest-match) "%"
  # form in the installed script, on the rpm target only. Traced from a real install where uid
  # extraction failed for every session despite the source file (and the deb/pacman scriptlets,
  # which aren't macro-processed) being correct.
  uid=$(basename "$(dirname "$(dirname "$socket")")")
  user=$(getent passwd "$uid" | cut -d: -f1) || continue
  [ -n "$user" ] || continue
  run_as() { runuser -u "$user" -- env "XDG_RUNTIME_DIR=/run/user/$uid" "$@"; }

  # The unit file above may be brand new to this user's already-running systemd --user manager
  # (first install) or just have changed (a future ExecStart/etc. tweak) -- either way its
  # in-memory unit cache is stale until told to re-scan. Unit-dir inotify auto-reload can't be
  # relied on here: this writes in place (cat > over an existing path, no rename), which doesn't
  # reliably fire the events that pickup depends on. Without this, is-active/restart/start below
  # would silently fail (or act on a since-replaced unit) with nothing in the journal to show for
  # it -- the exact bug this was added to fix.
  run_as systemctl --user daemon-reload

  # Logged unconditionally (uid, branch, and every command's own pass/fail) so a silent failure
  # here is never invisible again -- this whole block previously left no trace in journalctl even
  # when systemctl start/restart failed outright. `logger` writes to the system journal, taggable
  # and greppable with `journalctl -t unhush-postinstall`.
  if run_as systemctl --user is-active --quiet unhush.service; then
    # Systemd's already running the old instance -- its code stays validly mapped through the
    # file replacement above, so it's fine that this fires after the new payload landed. restart
    # is a single systemd-mediated stop-then-start.
    if run_as systemctl --user restart --no-block unhush.service; then
      logger -t unhush-postinstall "uid $uid: unhush.service was active; restart issued" 2>/dev/null || true
    else
      logger -t unhush-postinstall "uid $uid: unhush.service was active; restart FAILED (exit $?)" 2>/dev/null || true
    fi
  else
    # Not systemd-tracked. Either genuinely nothing running (do nothing -- an install/upgrade
    # must never surprise-start something that wasn't running), or a raw (manually-launched)
    # instance still on the old binary.
    raw_pids=$(unhush_raw_pids_for_uid "$uid")
    if [ -n "$raw_pids" ]; then
      roots=$(unhush_roots "$raw_pids")
      unhush_kill_roots "$roots"
      # Always brought back via systemd -- entering this branch at all already proves it was
      # running before this script started, so this finishes an in-flight restart rather than
      # surprise-starting something new. Not gated on is-enabled: that only governs login
      # autostart, not whether a manual start works.
      if run_as systemctl --user start --no-block unhush.service; then
        logger -t unhush-postinstall "uid $uid: killed raw pid(s) [$roots] (from [$raw_pids]); start issued" 2>/dev/null || true
      else
        logger -t unhush-postinstall "uid $uid: killed raw pid(s) [$roots] (from [$raw_pids]); start FAILED (exit $?)" 2>/dev/null || true
      fi
    else
      logger -t unhush-postinstall "uid $uid: unhush.service inactive and no raw pid found -- nothing to do" 2>/dev/null || true
    fi
  fi
done
