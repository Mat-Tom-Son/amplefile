//! Rootless output-bound input through `zwlr_virtual_pointer_v1` and
//! `zwp_virtual_keyboard_v1`, confined to the monitor selected in the screen
//! portal. The compositor profile decides how absolute positions map; the
//! advertised globals must satisfy it. No daemon, global socket listener,
//! clipboard access, or input at connection.
use crate::{
    compositor::{require_globals, AbsoluteInput, Profile},
    ei::Region,
    keyboard::Keyboard,
};
use anyhow::{ensure, Context, Result};
use std::{
    collections::HashMap,
    os::fd::AsFd,
    os::unix::fs::FileExt,
    time::{Duration, Instant},
};
use wayland_client::{
    backend::ObjectId,
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_keyboard, wl_output, wl_pointer, wl_registry, wl_seat},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
    zwp_virtual_keyboard_manager_v1, zwp_virtual_keyboard_v1,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1, zwlr_virtual_pointer_v1,
};
use xkbcommon::xkb;

#[derive(Clone, Debug, Default, PartialEq)]
struct Output {
    transform: u32,
    global: u32,
    name: String,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
}
#[derive(Default)]
struct State {
    outputs: HashMap<ObjectId, Output>,
    keyboard: Option<Keyboard>,
    virtual_state: Option<xkb::State>,
    keymap_bytes: Vec<u8>,
    virtual_keyboard: Option<zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1>,
    error: Option<String>,
}
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        state: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::GlobalRemove { name } = event {
            state.outputs.retain(|_, output| output.global != name);
        }
    }
}
impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        output: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_output::Event::Name { name } => {
                state.outputs.entry(output.id()).or_default().name = name
            }
            wl_output::Event::Geometry { transform, .. } => {
                state.outputs.entry(output.id()).or_default().transform = transform.into()
            }
            _ => {}
        }
    }
}
impl Dispatch<zxdg_output_v1::ZxdgOutputV1, wl_output::WlOutput> for State {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        output: &wl_output::WlOutput,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let info = state.outputs.entry(output.id()).or_default();
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => info.position = Some((x, y)),
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                info.size = Some((width, height))
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_keyboard::WlKeyboard, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_keyboard::Event::Keymap { format, fd, size } => {
                let result = (|| -> Result<()> {
                    ensure!(
                        matches!(format, WEnum::Value(wl_keyboard::KeymapFormat::XkbV1))
                            && size > 0
                            && size <= 1024 * 1024,
                        "Unsupported compositor keymap"
                    );
                    let mut bytes = vec![0; size as usize];
                    // The compositor can reuse one open-file description for
                    // many clients. pread never advances its shared fd offset.
                    std::fs::File::from(fd.try_clone()?).read_exact_at(&mut bytes, 0)?;
                    if state.keymap_bytes == bytes {
                        return Ok(());
                    }
                    state.keymap_bytes = bytes.clone();
                    let keyboard = Keyboard::parse(&bytes)?;
                    state.virtual_state = Some(keyboard.state());
                    state.keyboard = Some(keyboard);
                    state
                        .virtual_keyboard
                        .as_ref()
                        .context("No virtual keyboard")?
                        .keymap(1, fd.as_fd(), size);
                    Ok(())
                })();
                if let Err(error) = result {
                    state.error = Some(error.to_string());
                }
            }
            wl_keyboard::Event::Modifiers {
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
                ..
            } => {
                if let Some(keyboard) = &mut state.keyboard {
                    keyboard.modifiers = [mods_depressed, mods_latched, mods_locked, group];
                }
                if let Some(virtual_state) = &mut state.virtual_state {
                    virtual_state.update_mask(0, 0, mods_locked, 0, 0, group);
                }
            }
            _ => {}
        }
    }
}
wayland_client::delegate_noop!(State: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(State: ignore zxdg_output_manager_v1::ZxdgOutputManagerV1);
wayland_client::delegate_noop!(State: ignore zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1);
wayland_client::delegate_noop!(State: ignore zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1);
wayland_client::delegate_noop!(State: ignore zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1);
wayland_client::delegate_noop!(State: ignore zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1);

pub struct Input {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    pointer: zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
    keyboard: zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
    _seat: wl_seat::WlSeat,
    _keyboard_events: wl_keyboard::WlKeyboard,
    _outputs: Vec<(wl_output::WlOutput, zxdg_output_v1::ZxdgOutputV1)>,
    selected: ObjectId,
    geometry: Output,
    absolute_input: AbsoluteInput,
    region: Region,
    clock: Instant,
    held_keys: Vec<u32>,
    held_button: Option<u32>,
}
impl Input {
    pub fn new(
        profile: &Profile,
        position: (i32, i32),
        size: (i32, i32),
        pixels: (u32, u32),
    ) -> Result<Self> {
        let name = profile.name;
        let connection = Connection::connect_to_env()
            .with_context(|| format!("Cannot connect to the {name} Wayland session"))?;
        let (globals, mut queue) = registry_queue_init::<State>(&connection)?;
        let advertised: Vec<_> = globals
            .contents()
            .clone_list()
            .into_iter()
            .map(|global| (global.interface, global.version))
            .collect();
        require_globals(profile, &advertised)?;
        let qh = queue.handle();
        let seat = globals.bind::<wl_seat::WlSeat, _, _>(&qh, 1..=9, ())?;
        let manager = globals
            .bind::<zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1, _, _>(
                &qh,
                2..=2,
                (),
            )
            .with_context(|| format!("{name} virtual pointer v2 is required"))?;
        let key_manager = globals
            .bind::<zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1, _, _>(
                &qh,
                1..=1,
                (),
            )?;
        let output_manager =
            globals.bind::<zxdg_output_manager_v1::ZxdgOutputManagerV1, _, _>(&qh, 3..=3, ())?;
        let keyboard = key_manager.create_virtual_keyboard(&seat, &qh, ());
        let keyboard_events = seat.get_keyboard(&qh, ());
        let mut state = State {
            virtual_keyboard: Some(keyboard.clone()),
            ..Default::default()
        };
        let mut outputs = Vec::new();
        for global in globals
            .contents()
            .clone_list()
            .into_iter()
            .filter(|g| g.interface == "wl_output")
        {
            let output = globals.registry().bind::<wl_output::WlOutput, _, _>(
                global.name,
                global.version.min(4),
                &qh,
                (),
            );
            state.outputs.insert(
                output.id(),
                Output {
                    global: global.name,
                    ..Default::default()
                },
            );
            let xdg = output_manager.get_xdg_output(&output, &qh, output.clone());
            outputs.push((output, xdg));
        }
        queue.roundtrip(&mut state)?;
        if let Some(error) = &state.error {
            anyhow::bail!("{error}");
        }
        let matches: Vec<_> = state
            .outputs
            .iter()
            .filter(|(_, info)| {
                info.position == Some(position) && info.size == Some(size) && !info.name.is_empty()
            })
            .collect();
        ensure!(
            matches.len() == 1,
            "The shared screen must match exactly one {name} monitor"
        );
        let (selected, geometry) = (matches[0].0.clone(), matches[0].1.clone());
        ensure!(size.0 > 0 && size.1 > 0, "Invalid monitor dimensions");
        let scale = f64::from(pixels.0) / f64::from(size.0);
        ensure!(
            scale >= 1.0
                && scale <= 4.0
                && (f64::from(pixels.1) - f64::from(size.1) * scale).abs() <= 2.0,
            "Capture and {name} monitor geometry disagree"
        );
        // A wlroots-style compositor maps absolute input over the transformed
        // logical box. Only the normal transform has been checked there.
        ensure!(
            profile.absolute_input == AbsoluteInput::OutputBeforeTransform
                || geometry.transform == 0,
            "Rotated or flipped displays are not supported on {name}"
        );
        let output = outputs
            .iter()
            .find(|(output, _)| output.id() == selected)
            .unwrap();
        let pointer =
            manager.create_virtual_pointer_with_output(Some(&seat), Some(&output.0), &qh, ());
        let region = Region {
            mapping_id: Some(format!("{}:{}", name.to_ascii_lowercase(), geometry.name)),
            x: 0,
            y: 0,
            width: size.0 as u32,
            height: size.1 as u32,
            physical_scale: scale,
        };
        let mut input = Self {
            connection,
            queue,
            state,
            pointer,
            keyboard,
            _seat: seat,
            _keyboard_events: keyboard_events,
            _outputs: outputs,
            selected,
            geometry,
            absolute_input: profile.absolute_input,
            region,
            clock: Instant::now(),
            held_keys: vec![],
            held_button: None,
        };
        input.dispatch()?;
        ensure!(
            input.state.keyboard.is_some(),
            "Compositor did not supply a keyboard keymap"
        );
        Ok(input)
    }
    fn time(&self) -> u32 {
        self.clock.elapsed().as_millis() as u32
    }
    pub fn dispatch(&mut self) -> Result<()> {
        self.queue.roundtrip(&mut self.state)?;
        if let Some(error) = &self.state.error {
            anyhow::bail!("{error}");
        }
        ensure!(
            self.state.outputs.get(&self.selected) == Some(&self.geometry),
            "Shared monitor geometry changed; share the screen again"
        );
        Ok(())
    }
    pub fn regions(&self) -> Result<Vec<Region>> {
        Ok(vec![self.region.clone()])
    }
    pub fn ready_for(&self, _: bool, _: bool) -> bool {
        self.state.keyboard.is_some()
    }
    pub fn validate_text(&self, text: &str) -> Result<()> {
        self.state
            .keyboard
            .as_ref()
            .context("No compositor keymap")?
            .text(text)?;
        Ok(())
    }
    pub fn validate_shortcut(&self, keys: &[String]) -> Result<()> {
        self.state
            .keyboard
            .as_ref()
            .context("No compositor keymap")?
            .shortcut(keys)?;
        Ok(())
    }
    pub fn begin_sequence(&mut self) -> Result<()> {
        self.dispatch()
    }
    pub fn end_sequence(&mut self) {
        let _ = self.connection.flush();
    }
    fn point(&self, mapping: &str, x: f64, y: f64) -> Result<()> {
        ensure!(
            self.region.mapping_id.as_deref() == Some(mapping)
                && x.is_finite()
                && y.is_finite()
                && x >= 0.0
                && y >= 0.0
                && x < self.region.width.into()
                && y < self.region.height.into(),
            "Pointer is outside the shared monitor"
        );
        Ok(())
    }
    pub fn move_absolute(&mut self, mapping: &str, x: f64, y: f64) -> Result<()> {
        self.point(mapping, x, y)?;
        let (u, v) = absolute_position(
            self.absolute_input,
            self.geometry.transform,
            x / f64::from(self.region.width),
            y / f64::from(self.region.height),
        )?;
        self.pointer.motion_absolute(
            self.time(),
            (u * 65536.0).round() as u32,
            (v * 65536.0).round() as u32,
            65536,
            65536,
        );
        self.pointer.frame();
        self.connection.flush()?;
        Ok(())
    }
    fn button(&mut self, button: u32, down: bool) -> Result<()> {
        self.pointer.button(
            self.time(),
            button,
            if down {
                wl_pointer::ButtonState::Pressed
            } else {
                wl_pointer::ButtonState::Released
            },
        );
        self.held_button = down.then_some(button);
        self.pointer.frame();
        self.connection.flush()?;
        Ok(())
    }
    pub fn click(&mut self, mapping: &str, x: f64, y: f64, button: u32, count: u8) -> Result<()> {
        ensure!(
            (272..=274).contains(&button) && (1..=3).contains(&count),
            "Invalid mouse button or click count"
        );
        self.move_absolute(mapping, x, y)?;
        for _ in 0..count {
            self.button(button, true)?;
            self.button(button, false)?;
        }
        Ok(())
    }
    pub fn scroll(&mut self, mapping: &str, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        ensure!(
            dx.is_finite() && dy.is_finite() && dx.abs() <= 10000.0 && dy.abs() <= 10000.0,
            "Invalid scroll amount"
        );
        self.move_absolute(mapping, x, y)?;
        self.pointer
            .axis(self.time(), wl_pointer::Axis::HorizontalScroll, dx);
        self.pointer
            .axis(self.time(), wl_pointer::Axis::VerticalScroll, dy);
        self.pointer.frame();
        self.connection.flush()?;
        Ok(())
    }
    fn key(&mut self, code: u32, down: bool) -> Result<()> {
        let state = self
            .state
            .virtual_state
            .as_mut()
            .context("No virtual keyboard state")?;
        state.update_key(
            xkb::Keycode::new(code + 8),
            if down {
                xkb::KeyDirection::Down
            } else {
                xkb::KeyDirection::Up
            },
        );
        self.keyboard.modifiers(
            state.serialize_mods(xkb::STATE_MODS_DEPRESSED),
            state.serialize_mods(xkb::STATE_MODS_LATCHED),
            state.serialize_mods(xkb::STATE_MODS_LOCKED),
            state.serialize_layout(xkb::STATE_LAYOUT_EFFECTIVE),
        );
        self.keyboard
            .key(self.time(), code, if down { 1 } else { 0 });
        if down {
            self.held_keys.push(code);
        } else {
            self.held_keys.retain(|key| *key != code);
        }
        self.connection.flush()?;
        Ok(())
    }
    fn chord(&mut self, codes: &[u32]) -> Result<()> {
        for code in codes {
            self.key(*code, true)?;
        }
        for code in codes.iter().rev() {
            self.key(*code, false)?;
        }
        Ok(())
    }
    pub fn shortcut(&mut self, names: &[String]) -> Result<()> {
        let codes = self
            .state
            .keyboard
            .as_ref()
            .context("No compositor keymap")?
            .shortcut(names)?;
        self.chord(&codes)
    }
    pub fn type_text(&mut self, text: &str) -> Result<()> {
        let chords = self
            .state
            .keyboard
            .as_ref()
            .context("No compositor keymap")?
            .text(text)?;
        for chord in chords {
            self.chord(&chord)?;
        }
        Ok(())
    }
    pub async fn drag(&mut self, mapping: &str, path: &[(f64, f64)]) -> Result<()> {
        ensure!((2..=64).contains(&path.len()), "Use 2 to 64 drag points");
        for (x, y) in path {
            self.point(mapping, *x, *y)?;
        }
        self.move_absolute(mapping, path[0].0, path[0].1)?;
        self.button(272, true)?;
        let result = async {
            for (x, y) in &path[1..] {
                tokio::time::sleep(Duration::from_millis(16)).await;
                self.dispatch()?;
                self.move_absolute(mapping, *x, *y)?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let released = self.button(272, false);
        result.and(released)
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        for code in self.held_keys.clone().into_iter().rev() {
            let _ = self.key(code, false);
        }
        if let Some(button) = self.held_button {
            let _ = self.button(button, false);
        }
        self.keyboard.destroy();
        self.pointer.destroy();
        let _ = self.connection.flush();
    }
}

// niri applies the output transform to absolute input, just as it does for a
// hardware tablet. Undo it here because tool coordinates are displayed pixels.
// wlroots normalizes over the already transformed logical box; only the normal
// transform is admitted there, so the position passes through unchanged.
fn absolute_position(mode: AbsoluteInput, transform: u32, u: f64, v: f64) -> Result<(f64, f64)> {
    match mode {
        AbsoluteInput::OutputBeforeTransform => inverse_transform(transform, u, v),
        AbsoluteInput::LogicalBox => {
            ensure!(transform == 0, "Unsupported output transform");
            Ok((u, v))
        }
    }
}
fn inverse_transform(transform: u32, u: f64, v: f64) -> Result<(f64, f64)> {
    Ok(match transform {
        0 => (u, v),
        1 => (v, 1.0 - u),
        2 => (1.0 - u, 1.0 - v),
        3 => (1.0 - v, u),
        4 => (1.0 - u, v),
        5 => (v, u),
        6 => (u, 1.0 - v),
        7 => (1.0 - v, 1.0 - u),
        _ => anyhow::bail!("Unsupported output transform"),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transform_round_trip_preserves_displayed_coordinates() {
        for (u, v) in [(0.0, 0.0), (0.25, 0.75), (0.999, 0.001)] {
            for t in 0..8 {
                let (p, q) = inverse_transform(t, u, v).unwrap();
                let (x, y) = match t {
                    0 => (p, q),
                    1 => (1.0 - q, p),
                    2 => (1.0 - p, 1.0 - q),
                    3 => (q, 1.0 - p),
                    4 => (1.0 - p, q),
                    5 => (q, p),
                    6 => (p, 1.0 - q),
                    7 => (1.0 - q, 1.0 - p),
                    _ => unreachable!(),
                };
                assert!((x - u).abs() < 1e-12 && (y - v).abs() < 1e-12);
            }
        }
        assert!(inverse_transform(99, 0.5, 0.5).is_err());
    }
    #[test]
    fn logical_box_input_passes_through_and_refuses_transforms() {
        assert_eq!(
            absolute_position(AbsoluteInput::LogicalBox, 0, 0.25, 0.75).unwrap(),
            (0.25, 0.75)
        );
        for transform in 1..8 {
            assert!(absolute_position(AbsoluteInput::LogicalBox, transform, 0.5, 0.5).is_err());
            assert_eq!(
                absolute_position(AbsoluteInput::OutputBeforeTransform, transform, 0.25, 0.75)
                    .unwrap(),
                inverse_transform(transform, 0.25, 0.75).unwrap()
            );
        }
    }
}
