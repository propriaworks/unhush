#!/usr/bin/env bash
# Launch smoke test: starts Unhush in a throwaway X session and checks that it comes up, stays up,
# and shuts down cleanly. Catches what type checks, unit tests and packaging all miss -- a crash on
# launch (Electron 42.4.0 segfaulted when run unpacked), a broken preload/IPC path, or a file left
# out of the package. It does not exercise recording, transcription or paste.
#
#   scripts/smoke-test.sh packaged   release/linux-unpacked/unhush (after electron-builder)
#   scripts/smoke-test.sh dev        `electron .` -- the unpacked mode -- serving dist/ through
#                                    `vite preview` on the dev-server port (after `pnpm run build`)
#
# Needs xvfb-run and dbus-run-session; openbox (or metacity) and xprop are recommended (see below).
# Safe to run alongside a real Unhush: the instance under
# test gets its own HOME, config dir (single-instance lock, settings, log) and XDG_RUNTIME_DIR
# (command fifo, ydotoold socket), a private D-Bus session, and an X server of its own.

set -euo pipefail

MODE=${1:-}
case "$MODE" in packaged|dev) ;; *) echo "usage: $0 packaged|dev" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

STAY_UP_S=10

if [[ -z "${UNHUSH_SMOKE_TMP:-}" ]]; then
  # Outer run: set up the throwaway environment, then re-run this script inside a fresh X server
  # and D-Bus session that inherit it. The bus config lists no service directories, so nothing
  # installed on this machine (portals, keyring, gvfs) can be auto-started into the test: portal
  # calls fail fast, just as on a bare CI runner.
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/home" "$tmp/config"
  mkdir -m 700 "$tmp/runtime"
  cat >"$tmp/bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$tmp/runtime</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
  export UNHUSH_SMOKE_TMP=$tmp HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/config" XDG_RUNTIME_DIR="$tmp/runtime"
  export XDG_SESSION_TYPE=x11
  # Run on the Xvfb display even when invoked from a Wayland session
  unset WAYLAND_DISPLAY NIRI_SOCKET XDG_CURRENT_DESKTOP
  status=0
  xvfb-run -a dbus-run-session --config-file="$tmp/bus.conf" -- "$0" "$@" || status=$?
  exit "$status"
fi

tmp=$UNHUSH_SMOKE_TMP
app_pid=""
app_pgid=""
preview_pid=""
wm_pid=""
cleanup() {
  # Exact PIDs only; all are our own children. The app's whole process group too: if its main
  # process dies, Chromium helpers (e.g. the network service) can outlive it briefly, and would
  # otherwise keep writing into the temp dir as the outer run deletes it.
  [[ -n "$app_pid" ]] && kill -KILL "$app_pid" 2>/dev/null || true
  [[ -n "$app_pgid" ]] && kill -KILL -- "-$app_pgid" 2>/dev/null || true
  [[ -n "$preview_pid" ]] && kill "$preview_pid" 2>/dev/null || true
  [[ -n "$wm_pid" ]] && kill "$wm_pid" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "SMOKE TEST FAILED ($MODE): $*" >&2
  echo "--- unhush.log ---" >&2; cat "$tmp"/config/*/logs/unhush.log >&2 2>/dev/null || echo "(none)" >&2
  echo "--- stdout/stderr (last 40 lines) ---" >&2; tail -n 40 "$tmp/output.log" >&2 2>/dev/null || true
  exit 1
}

# A window manager, as on a real desktop. Without one, the app's waitForWindowManager() waits 15s
# before creating its windows. Any EWMH window manager will do: it sets the root-window property
# that function polls for (with xprop, which is also how we check here).
for wm in openbox metacity; do
  command -v "$wm" >/dev/null || continue
  "$wm" >"$tmp/wm.log" 2>&1 &
  wm_pid=$!
  for _ in $(seq 40); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break
    sleep 0.25
  done
  break
done
if ! xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
  echo "smoke ($MODE): no window manager running (install openbox); startup will wait 15s for one" >&2
fi

if [[ "$MODE" == dev ]]; then
  [[ -f dist/index.html ]] || fail "dist/ not built -- run 'pnpm run build' first"
  # An unpacked app loads http://localhost:5173 (see createWindow); serve the built renderer there
  pnpm exec vite preview --port 5173 --strictPort >"$tmp/preview.log" 2>&1 &
  preview_pid=$!
  for _ in $(seq 60); do curl -sf -o /dev/null http://localhost:5173 && break; sleep 0.5; done
  curl -sf -o /dev/null http://localhost:5173 || { cat "$tmp/preview.log" >&2; fail "vite preview did not start"; }
  # The electron package downloads its binary on first use if the install step didn't (as in a
  # fresh checkout), printing progress on stdout -- so do that first, then capture only the path.
  node -e 'require("electron")' >/dev/null
  electron_bin=$(node -p 'require("electron")')
  [[ -x "$electron_bin" ]] || fail "no Electron binary at '$electron_bin'"
  cmd=("$electron_bin" . --no-sandbox)
else
  [[ -x release/linux-unpacked/unhush ]] || fail "release/linux-unpacked/unhush not found -- run electron-builder first"
  # --no-sandbox: chrome-sandbox isn't setuid in the unpacked tree, and CI runners forbid the
  # unprivileged user namespaces Chromium would fall back to
  cmd=(release/linux-unpacked/unhush --no-sandbox)
fi

# setsid: its own process group (pgid = its pid), so cleanup can kill any helpers it leaves
setsid "${cmd[@]}" >"$tmp/output.log" 2>&1 &
app_pid=$!
app_pgid=$app_pid

log_file() { compgen -G "$tmp/config/*/logs/unhush.log" | head -n1 || true; }

# Waits up to $2 seconds for the log to contain $1, failing at once if the app exits first
wait_for_log() {
  local pattern=$1 deadline=$((SECONDS + $2)) f s
  while ((SECONDS < deadline)); do
    kill -0 "$app_pid" 2>/dev/null || { wait "$app_pid" && s=0 || s=$?; app_pid=""; fail "exited (status $s) before logging '$pattern'"; }
    f=$(log_file)
    [[ -n "$f" ]] && grep -qF -- "$pattern" "$f" && return 0
    sleep 0.5
  done
  fail "timed out after $2s waiting for '$pattern'"
}

# Fails on crashes only. Errors from the environment -- no ydotool or /dev/uinput on a bare CI
# runner -- are what a user missing those would see, and the app must stay up through them, which
# the liveness checks establish; they're listed at the end rather than failed on.
crash_check() {
  grep -F "renderer process gone" "$(log_file)" >&2 && fail "renderer crashed"
  grep -F "uncaught exception in main process" "$(log_file)" >&2 && fail "uncaught exception in the main process"
  return 0
}

# Generous: without a window manager, startup alone waits 15s for one before creating windows
wait_for_log "app ready after" 30
wait_for_log "renderer mounted" 45
echo "smoke ($MODE): started; checking it stays up for ${STAY_UP_S}s"

for _ in $(seq "$STAY_UP_S"); do
  sleep 1
  kill -0 "$app_pid" 2>/dev/null || { wait "$app_pid" && s=0 || s=$?; app_pid=""; fail "exited (status $s) within ${STAY_UP_S}s of starting"; }
done
crash_check

# Chromium turns SIGTERM into a normal quit, which runs the will-quit teardown
kill -TERM "$app_pid"
for _ in $(seq 30); do kill -0 "$app_pid" 2>/dev/null || break; sleep 0.5; done
kill -0 "$app_pid" 2>/dev/null && fail "still running 15s after SIGTERM"
wait "$app_pid" && status=0 || status=$?
app_pid=""
((status == 0)) || fail "exit status $status after SIGTERM"
grep -qF "shutting down after" "$(log_file)" || fail "no shutdown line in the log"
crash_check

echo "smoke ($MODE): OK -- started, stayed up ${STAY_UP_S}s, shut down cleanly."
echo "Errors and warnings logged (environment-dependent; not failures):"
grep -E "ERROR: |WARN: " "$(log_file)" || echo "(none)"
