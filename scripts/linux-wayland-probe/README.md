# Private Linux desktop acceptance

`acceptance.sh` runs only inside a disposable GNOME test container as uid 1000.
It creates private D-Bus, PipeWire, WirePlumber, a headless GNOME seat, a real
portal chooser and an owned GTK editor. Do not mount the host's session bus,
home, keyring, graphics device or input devices.

The fixture needs GNOME Shell and its portal backend, XWayland, Python GTK,
python-dbusmock, PipeWire/WirePlumber, Node 24 and the helper runtime libraries.
With a prepared acceptance image, run:

```sh
podman run --rm --init --shm-size=1g --userns keep-id:uid=1000,gid=1000 --user 1000:1000 --security-opt label=disable -v "$PWD:/work:ro" -e HOME=/tmp/amplefile-gnome-home -e AMPLEFILE_ISOLATED_GNOME_TEST=1 ACCEPTANCE_IMAGE bash -euc 'mkdir -p "$HOME"; bash /work/scripts/linux-wayland-probe/acceptance.sh'
```

Build the helpers and install npm dependencies first. The fixture exercises
100% and 125% scaling, PNG capture, real input, exact saved bytes, stale and
wrong-owner rejection, seat exclusion, native screen-lock revocation, and
Stop during a chooser. It then runs semantic multilingual AT-SPI text entry
and a real Pi client using scripted provider responses. Login services are
simulated inside the container; this is not physical desktop qualification.
