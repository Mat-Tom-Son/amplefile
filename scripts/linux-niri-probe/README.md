# Private niri acceptance

Run from a Linux checkout with niri, Xvfb/xauth, Rust, Python GTK and
python-dbusmock installed:

```sh
bash scripts/linux-niri-probe/acceptance.sh 1
bash scripts/linux-niri-probe/acceptance.sh 1.25
```

The fixture creates a nested niri on a private X display, private Wayland and
D-Bus sockets, a simulated logind session and an owned GTK editor. It sends no
input to the person's desktop. It verifies real clicks, exact text and shortcut
replacement, repeated keymap connections, output mapping and lock revocation.
Temporary evidence is kept in the printed private directory.

This nested seat has no GPU capture device. Live capture diagnostics are
separate Rust examples, require `AMPLEFILE_LIVE_SHARE_DIAGNOSTIC=1`, and open
the real system screen chooser. `portal-capture-diagnostic` retains one grant
while `capture` commands check bounded frames and exact PNG pixels; `stop` or
stdin EOF closes it. These diagnostics send no input. They are not needed for
the private acceptance commands above.
