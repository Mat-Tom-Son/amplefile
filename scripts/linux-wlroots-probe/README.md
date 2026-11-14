# Private Sway acceptance

Sway is a prepared wlroots-family profile, not a supported desktop: it has no
lock signal another application can observe, so the product refuses it before
any chooser opens. This fixture checks everything else on that path, so adding
Sway (or another wlroots compositor) later only needs a trustworthy lock signal.

Run from a Linux checkout with Rust and rootless podman:

```sh
bash scripts/linux-wlroots-probe/acceptance.sh 1
bash scripts/linux-wlroots-probe/acceptance.sh 1.25
```

The script builds the probes on the host, builds the image from
`Containerfile` (Fedora 44 packages only) if it is missing, and runs as uid
1000 with no network and only the repository mounted read-only. Inside, it
starts a private Xvfb, D-Bus, PipeWire, WirePlumber, Sway on the X11 backend
(pixman rendering), `xdg-desktop-portal` with the wlr backend and an owned
GTK editor. The X11 backend gives the seat a keyboard, so the compositor has a
keymap to share; `xdotool` presses Shift only on that private X server.

It verifies:

- the product entry point refuses Sway before opening a portal;
- output-bound clicks land on exact logical GTK coordinates, with exact text
  and shortcut replacement over two connections;
- a second connection is refused while the seat has no keymap (the previous
  virtual keyboard was the last one used) and works after a real key press;
- portal capture through system memory has the output's physical size and
  every pixel exactly matches the solid background;
- a mismatched logical geometry is refused, a hot-plugged unrelated output
  keeps the grant, and a scale change or removal of the selected output
  invalidates it;
- a rotated output is refused.

Sway draws with pixman here, so `xdg-desktop-portal-wlr` offers shared-memory
buffers; GPU DMA-BUF capture on Sway is not exercised. Temporary evidence stays
in the container and is discarded with it.
