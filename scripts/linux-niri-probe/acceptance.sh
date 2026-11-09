#!/usr/bin/env bash
# Isolated native-input/lock acceptance; never connects to the person's seat.
set -Eeuo pipefail
umask 077
probe_repo=$(cd "$(dirname "$0")/../.." && pwd)
probe_scale=${1:-1}
case "$probe_scale" in 1|1.25) ;; *) exit 2;; esac
if [[ ${AMPLEFILE_NIRI_XVFB:-} != 1 ]]; then
  export CARGO_TARGET_DIR="$probe_repo/out/linux-wayland-target"
  cargo build --locked --manifest-path "$probe_repo/desktop/native/linux-wayland/Cargo.toml" --example niri-input-probe --example niri-lock-probe
  exec env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u NIRI_SOCKET AMPLEFILE_NIRI_XVFB=1 xvfb-run -a -s '-screen 0 1920x1080x24' bash "$0" "$probe_scale"
fi
probe_root=$(mktemp -d "${TMPDIR:-/tmp}/amplefile-niri-test-XXXXXX")
chmod 700 "$probe_root"
export XDG_RUNTIME_DIR="$probe_root" XDG_CONFIG_HOME="$probe_root/config" XDG_DATA_HOME="$probe_root/data"
export XDG_SESSION_ID=amplefiletest XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=niri AMPLEFILE_ISOLATED_NIRI_TEST=1
export GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe GTK_A11Y=none NO_AT_BRIDGE=1 WINIT_UNIX_BACKEND=x11
unset WAYLAND_DISPLAY WAYLAND_SOCKET NIRI_SOCKET
cleanup(){ kill "${probe_pid:-}" "${probe_login_pid:-}" "${probe_bus_pid:-}" 2>/dev/null || true; }
trap cleanup EXIT
cat > "$probe_root/bus.conf" <<XML
<busconfig><type>session</type><listen>unix:path=$probe_root/bus</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>
XML
mapfile -t probe_bus < <(dbus-daemon --config-file="$probe_root/bus.conf" --fork --print-address --print-pid)
export DBUS_SESSION_BUS_ADDRESS="${probe_bus[0]}" DBUS_SYSTEM_BUS_ADDRESS="${probe_bus[0]}"
probe_bus_pid=${probe_bus[1]}
python3 "$probe_repo/scripts/linux-niri-probe/login-mock.py" > "$probe_root/login.log" 2>&1 &
probe_login_pid=$!
for probe_try in {1..50}; do [[ -f "$probe_root/login-ready" ]] && break; kill -0 "$probe_login_pid"; sleep .1; done
test -f "$probe_root/login-ready"
cat > "$probe_root/config.kdl" <<KDL
layout {
 gaps 0
 default-column-width { proportion 1.0; }
}
output "winit" { scale $probe_scale; }
hotkey-overlay { skip-at-startup; }
prefer-no-csd
spawn-at-startup "python3" "$probe_repo/scripts/linux-niri-probe/input-fixture.py"
KDL
# Reject a bad config before niri can fall back to a personal/default config.
niri validate -c "$probe_root/config.kdl"
niri -c "$probe_root/config.kdl" > "$probe_root/niri.log" 2>&1 &
probe_pid=$!
for probe_try in {1..100}; do
 probe_socket=$(find "$probe_root" -maxdepth 1 -type s -name 'niri*.sock' -print -quit)
 [[ -S "$probe_socket" && -f "$probe_root/fixture-ready" ]] && break
 kill -0 "$probe_pid"; sleep .1
done
test -S "$probe_socket"; test -f "$probe_root/fixture-ready"
export NIRI_SOCKET="$probe_socket"
export WAYLAND_DISPLAY=$(basename "$(find "$probe_root" -maxdepth 1 -type s -name 'wayland-*' -print -quit)")
niri msg --json outputs > "$probe_root/output.json"
for probe_pass in 1 2; do
 "$probe_repo/out/linux-wayland-target/debug/examples/niri-input-probe"
 sleep .2
 python3 - "$probe_root" "$probe_pass" <<'PY'
import json,sys
from pathlib import Path
result=json.loads((Path(sys.argv[1])/'result.json').read_text())
assert result['clicked']==int(sys.argv[2]),result
assert result['text']=='Exact final bytes',result
print('PASS GTK click, exact text/shortcut replacement, and repeat connection')
PY
done
"$probe_repo/out/linux-wayland-target/debug/examples/niri-lock-probe"
printf 'PASS private niri scale=%s; evidence: %s\n' "$probe_scale" "$probe_root"
