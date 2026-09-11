#!/bin/bash
# Stop a running Unhush *before* the package payload is deleted.
#
# This used to live in the post-remove scriptlet, which is too late: rpm (and dpkg, and pacman) all
# unlink the files first, so the app was being asked to quit with its own binary already gone.
#
# Reached through the `fpm` escape hatch in package.json (--before-remove), since electron-builder
# itself only wires up after-install/after-remove.
#
# rpm passes the number of remaining packages ("0" = final removal, "1" = upgrade); dpkg's prerm
# passes remove/upgrade/deconfigure; pacman's pre_remove passes nothing. The app is stopped for all
# of them: on an upgrade the running process keeps executing the *old* code from unlinked inodes
# while any subprocess it spawns afterwards execs the *new* binary -- a mismatch that shows up as
# the app half-working until the user restarts it. Nothing is at risk in stopping it: Unhush holds
# no unsaved document, only (at most) a recording in progress.
#
# It is deliberately not restarted afterwards. A root scriptlet has no graphical session, so putting
# the app back means reconstructing one from the dying process's /proc/PID/environ and handing it to
# `runuser`; that was tried, did not work on Fedora/KDE, and is more machinery than an upgrade
# warrants. After an upgrade the user launches Unhush again themselves.
case "${1-}" in
  0|remove|""|1|upgrade|deconfigure) ;;
  *) exit 0 ;;
esac

# Identified by /proc/PID/exe -- the kernel's own record of the running binary -- never by process
# name or command line, so this cannot match an unrelated process that merely mentions "unhush".
# The payload is still in place here, so the plain path matches; the "(deleted)" form appears once
# an upgrade has replaced the file under the running process. /opt/Unhush is electron-builder's
# install prefix (productName).
app=/opt/Unhush/unhush

# One find rather than a readlink per process: forking for each of a few hundred /proc entries and
# repeating that each poll measured ~2s per scan on the dev box -- far too slow for a scriptlet.
unhush_pids() {
  find /proc -mindepth 2 -maxdepth 2 -name exe \
    \( -lname "$app" -o -lname "$app (deleted)" \) -printf '%h\n' 2>/dev/null |
    sed 's#^/proc/##'
}

# Chromium is a process tree -- browser, two zygotes, GPU, renderers, utilities -- and every one of
# them has the same /proc/PID/exe, so unhush_pids returns the whole tree. Only the roots may be
# signalled: a process whose parent is not itself Unhush. SIGTERM to a renderer or to the GPU
# process is not a shutdown request. The browser treats an unexpected child death as a crash,
# reports it to the desktop as one, and immediately relaunches the child by exec'ing
# /proc/self/exe -- which mid-transaction is a binary being replaced or removed, so the relaunch
# fails with
#   /proc/self/exe: error while loading shared libraries: libffmpeg.so: cannot open shared object file
# That was the crash-on-uninstall, and it was self-inflicted. Signalling the browser alone lets it
# shut its children down in its own order, which is the only sequence it accepts as an orderly quit.
roots() {
  # Unquoted, so the newline-separated list collapses to a single space-separated line -- the
  # membership test below is a substring match and needs " $ppid " to be literally that.
  all=" $(echo $1) "
  for pid in $1; do
    # /proc/PID/stat's second field is the comm in parentheses and may itself contain spaces or a
    # ")", so read the fields *after* the last ")": state, then ppid.
    rest=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null) || continue
    ppid=$(printf '%s' "$rest" | cut -d' ' -f2)
    case "$all" in
      *" $ppid "*) ;;                  # parent is Unhush too: a child, left to the browser
      *) printf '%s\n' "$pid" ;;
    esac
  done
}

pids=$(unhush_pids)
if [ -n "$pids" ]; then
  # SIGTERM: Electron turns it into an ordinary app quit, so will-quit still runs and the app
  # removes its own FIFO and stops its ydotoold child -- with every file it needs still present.
  kill $(roots "$pids") 2>/dev/null
  for _ in $(seq 10); do
    [ -n "$(unhush_pids)" ] || break
    sleep 0.5
  done
  # Anything still up after 5s ignored SIGTERM or was orphaned by a browser that already exited;
  # either way nothing is left to shut it down in order, so SIGKILL is safe here.
  remaining=$(unhush_pids)
  if [ -n "$remaining" ]; then
    kill -9 $remaining 2>/dev/null
  fi
fi
