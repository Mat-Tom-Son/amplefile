#!/usr/bin/env bash
# Private Sway acceptance in a disposable container: headless Sway, private
# D-Bus, PipeWire and portal. The person's sockets, home, keyring, graphics and
# input devices are never mounted; the container has no network.
set -Eeuo pipefail
umask 077
probe_scale=${1:-1}
case "$probe_scale" in 1|1.25) ;; *) echo "scale must be 1 or 1.25" >&2; exit 2;; esac
probe_background=204060
probe_output=X11-1

if [[ ${AMPLEFILE_ISOLATED_WLROOTS_TEST:-} != 1 ]]; then
  probe_repo=$(cd "$(dirname "$0")/../.." && pwd)
  probe_image=${AMPLEFILE_WLROOTS_IMAGE:-localhost/amplefile-wlroots-acceptance}
  export CARGO_TARGET_DIR="$probe_repo/out/linux-wayland-target"
  cargo build --locked --manifest-path "$probe_repo/desktop/native/linux-wayland/Cargo.toml" \
    --example wlroots-input-probe --example wlroots-capture-probe
  podman image exists "$probe_image" || podman build -t "$probe_image" \
    -f "$probe_repo/scripts/linux-wlroots-probe/Containerfile" "$probe_repo/scripts/linux-wlroots-probe"
  exec podman run --rm --init --network none --shm-size=1g \
    --userns keep-id:uid=1000,gid=1000 --user 1000:1000 --security-opt label=disable \
    -v "$probe_repo:/work:ro" -e AMPLEFILE_ISOLATED_WLROOTS_TEST=1 -e HOME=/tmp/amplefile-wlroots-home \
    "$probe_image" bash /work/scripts/linux-wlroots-probe/acceptance.sh "$probe_scale"
fi

test -f /run/.containerenv
test "$(id -u)" = 1000
probe_bin=/work/out/linux-wayland-target/debug/examples
if [[ ${1:-} != inner && ${2:-} != inner ]]; then
  probe_root=$(mktemp -d /tmp/amplefile-wlroots-test-XXXXXX)
  chmod 700 "$probe_root"
  mkdir -p "$HOME" "$probe_root/config/xdg-desktop-portal-wlr" "$probe_root/config/xdg-desktop-portal"
  export XDG_RUNTIME_DIR="$probe_root" XDG_CONFIG_HOME="$probe_root/config" XDG_DATA_HOME="$probe_root/data"
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway
  # The X11 backend on a private Xvfb gives the seat a keyboard, so the
  # compositor has a keymap to share. Headless has none and is refused.
  export WLR_BACKENDS=x11 WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_X11_OUTPUTS=1
  export GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1 GTK_A11Y=none NO_AT_BRIDGE=1
  unset WAYLAND_DISPLAY WAYLAND_SOCKET SWAYSOCK DISPLAY
  exec xvfb-run -a -s '-screen 0 1920x1200x24' dbus-run-session -- bash "$0" "$probe_scale" inner
fi

probe_root=$XDG_RUNTIME_DIR
[[ $probe_root == /tmp/amplefile-wlroots-test-* ]]
probe_pids=()
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then tail -n 40 "$probe_root"/*.log 2>/dev/null || true; fi
  kill "${probe_pids[@]}" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
start() { local log=$1; shift; "$@" > "$probe_root/$log.log" 2>&1 & probe_pids+=($!); }

start pipewire pipewire
start wireplumber wireplumber
cat > "$probe_root/sway.conf" <<CONF
output $probe_output resolution 1600x1000 position 0 0 scale $probe_scale bg #$probe_background solid_color
default_border none
default_floating_border none
gaps inner 0
seat * hide_cursor 100
CONF
# Fedora's sway carries file capabilities, which a rootless user namespace
# cannot grant. An unprivileged copy has none and needs none here.
install -m 700 /usr/bin/sway "$probe_root/sway"
"$probe_root/sway" --validate -c "$probe_root/sway.conf" > /dev/null
start sway "$probe_root/sway" -c "$probe_root/sway.conf"
for _ in {1..100}; do
  probe_socket=$(find "$probe_root" -maxdepth 1 -type s -name 'sway-ipc.*.sock' -print -quit)
  [[ -S "$probe_socket" ]] && break
  sleep .1
done
test -S "$probe_socket"
export SWAYSOCK="$probe_socket"
export WAYLAND_DISPLAY=$(basename "$(find "$probe_root" -maxdepth 1 -type s -name 'wayland-*' -print -quit)")
dbus-update-activation-environment WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP XDG_RUNTIME_DIR XDG_CONFIG_HOME
cat > "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config" <<CONF
[screencast]
chooser_type=none
output_name=$probe_output
CONF
printf '[preferred]\ndefault=wlr\n' > "$XDG_CONFIG_HOME/xdg-desktop-portal/sway-portals.conf"
start xdpw /usr/libexec/xdg-desktop-portal-wlr -l DEBUG
start portal /usr/libexec/xdg-desktop-portal -v
gdbus wait --session --timeout 15 org.freedesktop.impl.portal.desktop.wlr
gdbus wait --session --timeout 15 org.freedesktop.portal.Desktop
start fixture python3 /work/scripts/linux-wlroots-probe/input-fixture.py
for _ in {1..100}; do [[ -f "$probe_root/fixture-ready" ]] && break; sleep .1; done
test -f "$probe_root/fixture-ready"
swaymsg -t get_version -r > "$probe_root/version.json"
swaymsg -t get_outputs -r > "$probe_root/output.json"
read -r probe_x probe_y probe_w probe_h < <(python3 -c '
import json,sys
o=[o for o in json.load(open(sys.argv[1])) if o["name"]==sys.argv[2]][0]
r=o["rect"];print(r["x"],r["y"],r["width"],r["height"])' "$probe_root/output.json" "$probe_output")
echo "Sway $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["human_readable"])' "$probe_root/version.json"), $probe_output logical ${probe_w}x${probe_h} at scale $probe_scale"

for probe_pass in 1 2; do
  if (( probe_pass == 2 )); then
    # wlroots shares the last-used keyboard's keymap. The previous virtual
    # keyboard is gone, so the seat has none until a real key is pressed:
    # the helper must refuse rather than guess a layout.
    if probe_error=$("$probe_bin/wlroots-input-probe" type "$probe_x" "$probe_y" "$probe_w" "$probe_h" "$probe_scale" 2>&1); then
      echo "Input ran without a compositor keymap" >&2; exit 1
    fi
    [[ $probe_error == *"has not shared a keyboard layout"* ]] || { echo "$probe_error" >&2; exit 1; }
    echo "PASS no keymap after the previous virtual keyboard: refused before input"
    # A key on the fixture's private X keyboard, which is Sway's seat keyboard.
    xdotool key shift
    sleep .3
  fi
  "$probe_bin/wlroots-input-probe" type "$probe_x" "$probe_y" "$probe_w" "$probe_h" "$probe_scale"
  sleep .3
  python3 - "$probe_root" "$probe_pass" <<'PY'
import json,sys
from pathlib import Path
result=json.loads((Path(sys.argv[1])/'result.json').read_text())
passes=int(sys.argv[2])
assert result['clicked']==passes,result
assert result['text']=='Exact final bytes',result
# The fixture window fills the output from its origin: logical tool
# coordinates must land on the same GTK coordinates.
for got,want in zip(result['positions'][-2:],[[150,120],[150,220]]):
  assert abs(got[0]-want[0])<=1 and abs(got[1]-want[1])<=1,(got,want)
print('PASS GTK click at exact logical coordinates, exact text/shortcut replacement, repeat connection')
PY
done

# Capture the bare background, then check refusal, pixels and output changes.
pkill -f input-fixture.py
xdotool key shift
sleep .5
"$probe_bin/wlroots-capture-probe" "$probe_scale" "$probe_background" "$probe_output"

swaymsg output "$probe_output" scale "$probe_scale" > /dev/null
sleep .3
# A rotated output is refused on the wlroots logical-box mapping.
swaymsg output "$probe_output" transform 90 > /dev/null
sleep .3
swaymsg -t get_outputs -r > "$probe_root/output.json"
read -r probe_x probe_y probe_w probe_h < <(python3 -c '
import json,sys
o=[o for o in json.load(open(sys.argv[1])) if o["name"]==sys.argv[2]][0]
r=o["rect"];print(r["x"],r["y"],r["width"],r["height"])' "$probe_root/output.json" "$probe_output")
xdotool key shift
sleep .3
if probe_error=$("$probe_bin/wlroots-input-probe" type "$probe_x" "$probe_y" "$probe_w" "$probe_h" "$probe_scale" 2>&1); then
  echo "Input ran on a rotated output" >&2; exit 1
fi
[[ $probe_error == *"Rotated or flipped displays are not supported"* ]] || { echo "$probe_error" >&2; exit 1; }
echo "PASS rotated output refused before input"
swaymsg output "$probe_output" transform normal > /dev/null
sleep .3

# Removing the selected output invalidates a held grant.
swaymsg -t get_outputs -r > "$probe_root/output.json"
read -r probe_x probe_y probe_w probe_h < <(python3 -c '
import json,sys
o=[o for o in json.load(open(sys.argv[1])) if o["name"]==sys.argv[2]][0]
r=o["rect"];print(r["x"],r["y"],r["width"],r["height"])' "$probe_root/output.json" "$probe_output")
xdotool key shift
sleep .3
coproc probe_hold { "$probe_bin/wlroots-input-probe" hold "$probe_x" "$probe_y" "$probe_w" "$probe_h" "$probe_scale"; }
read -r probe_line <&"${probe_hold[0]}"; [[ $probe_line == READY ]]
swaymsg output "$probe_output" disable > /dev/null
sleep .3
echo >&"${probe_hold[1]}"
read -r probe_line <&"${probe_hold[0]}"
[[ $probe_line == INVALID* ]] || { echo "Output removal kept the grant: $probe_line" >&2; exit 1; }
echo "PASS removing the selected output invalidates input: ${probe_line#INVALID }"
printf 'PASS private Sway scale=%s (prepared profile; not allow-listed: no observable lock signal)\n' "$probe_scale"
