//! Which native path a Wayland session may use, decided before any chooser.
//!
//! A desktop is identified by name and then admitted only through an explicit
//! allow-list. The protocol path for wlroots-style compositors additionally
//! requires the globals the compositor actually advertises. Every admitted
//! desktop must have a lock signal AmpleFile can observe: lock revokes control.
use anyhow::{anyhow, ensure, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desktop {
    Gnome,
    Kde,
    Niri,
    Sway,
    Hyprland,
    River,
    Labwc,
    Wayfire,
    Cosmic,
}

/// How the helper learns that the screen was locked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockSignal {
    /// The desktop's own screen-saver service (GNOME and KDE).
    ScreenSaverService,
    /// The compositor itself sets logind's LockedHint while a session lock is
    /// held, whichever locker client draws it (niri).
    CompositorLockedHint,
    /// Hyprland's `hyprland_lock_notifier_v1` global reports compositor lock
    /// state to any client. Not implemented: no qualified Hyprland fixture.
    HyprlandLockNotify,
    /// Nothing outside the locker can observe the lock. The wlroots lockers
    /// (swaylock, waylock, gtklock) and these compositors never set
    /// LockedHint, and `ext-session-lock-v1` state is private to its client.
    Unobservable,
}

/// How a compositor interprets an output-bound absolute pointer position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbsoluteInput {
    /// Normalized over the untransformed output, then transformed, as niri
    /// does for a tablet. The helper undoes any output transform.
    OutputBeforeTransform,
    /// Normalized over the output's transformed logical box (wlroots
    /// `wlr_cursor` mapping). Only the normal transform is qualified.
    LogicalBox,
}

/// The PipeWire buffers a capture pipeline accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureMemory {
    /// System memory converted to RGBA by the media framework.
    System,
    /// Only explicitly linear XRGB DMA-BUFs, read through the kernel fd.
    LinearDmaBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub desktop: Desktop,
    pub name: &'static str,
    pub lock: LockSignal,
    pub absolute_input: AbsoluteInput,
    pub capture: CaptureMemory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path {
    /// ScreenCast + RemoteDesktop portal with libei input.
    Portal(Desktop),
    /// ScreenCast portal for pixels, then output-bound virtual pointer and
    /// virtual keyboard protocols.
    VirtualInput(Profile),
}

/// Desktops qualified end to end. Adding one requires a lock signal from
/// `LockSignal` other than `Unobservable`, its monitor in `portal.rs`, and a
/// private acceptance run (input at 100% and 125%, lock revocation, output
/// change and exact capture pixels). See docs/linux-build.md.
pub const ALLOW_LIST: &[Desktop] = &[Desktop::Gnome, Desktop::Kde, Desktop::Niri];

const NAMES: &[(&str, Desktop)] = &[
    ("GNOME", Desktop::Gnome),
    ("KDE", Desktop::Kde),
    ("niri", Desktop::Niri),
    ("sway", Desktop::Sway),
    ("Hyprland", Desktop::Hyprland),
    ("river", Desktop::River),
    ("labwc", Desktop::Labwc),
    ("Wayfire", Desktop::Wayfire),
    ("COSMIC", Desktop::Cosmic),
];

/// Identify exactly one known desktop in `XDG_CURRENT_DESKTOP`. Unknown
/// entries such as `ubuntu` or the generic `wlroots` marker are ignored; two
/// known desktops are ambiguous and refused.
pub fn identify(current_desktop: &str) -> Result<Desktop> {
    let mut found: Option<Desktop> = None;
    for entry in current_desktop.split(':') {
        let Some((_, desktop)) = NAMES.iter().find(|(name, _)| name.eq_ignore_ascii_case(entry)) else { continue };
        ensure!(found.is_none_or(|known| known == *desktop), "Screen sharing requires one identifiable desktop session");
        found = Some(*desktop);
    }
    found.ok_or_else(|| anyhow!("Screen sharing requires an identifiable GNOME, KDE or niri desktop session"))
}

pub fn path(desktop: Desktop) -> Path {
    let wlroots = |desktop, name, lock| Path::VirtualInput(Profile {
        desktop, name, lock, absolute_input: AbsoluteInput::LogicalBox, capture: CaptureMemory::System,
    });
    match desktop {
        Desktop::Gnome | Desktop::Kde | Desktop::Cosmic => Path::Portal(desktop),
        Desktop::Niri => Path::VirtualInput(Profile {
            desktop, name: "niri", lock: LockSignal::CompositorLockedHint,
            absolute_input: AbsoluteInput::OutputBeforeTransform, capture: CaptureMemory::LinearDmaBuf,
        }),
        Desktop::Sway => wlroots(desktop, "Sway", LockSignal::Unobservable),
        Desktop::Hyprland => wlroots(desktop, "Hyprland", LockSignal::HyprlandLockNotify),
        Desktop::River => wlroots(desktop, "river", LockSignal::Unobservable),
        Desktop::Labwc => wlroots(desktop, "labwc", LockSignal::Unobservable),
        Desktop::Wayfire => wlroots(desktop, "Wayfire", LockSignal::Unobservable),
    }
}

pub fn lock_signal(desktop: Desktop) -> LockSignal {
    match path(desktop) {
        Path::Portal(Desktop::Cosmic) => LockSignal::Unobservable,
        Path::Portal(_) => LockSignal::ScreenSaverService,
        Path::VirtualInput(profile) => profile.lock,
    }
}

fn display_name(desktop: Desktop) -> &'static str {
    match path(desktop) {
        Path::VirtualInput(profile) => profile.name,
        Path::Portal(Desktop::Gnome) => "GNOME",
        Path::Portal(Desktop::Kde) => "KDE Plasma",
        Path::Portal(_) => "COSMIC",
    }
}

/// Refuse a desktop that is not qualified, before any portal or chooser opens.
pub fn qualify(desktop: Desktop) -> Result<Path> {
    let name = display_name(desktop);
    ensure!(lock_signal(desktop) != LockSignal::Unobservable,
        "Computer Control is not available on {name}: it does not let other applications see when the screen is locked, so AmpleFile could not end control on lock. It is available on GNOME, KDE Plasma and niri.");
    ensure!(ALLOW_LIST.contains(&desktop),
        "Computer Control has not been qualified on {name}. It is available on GNOME, KDE Plasma and niri.");
    Ok(path(desktop))
}

/// The globals the virtual-input path binds, with the minimum versions it
/// uses. `wl_output` 4 supplies the output name; `zxdg_output_manager_v1` 3
/// the logical geometry; virtual pointer 2 the output binding.
const REQUIRED_GLOBALS: &[(&str, u32)] = &[
    ("wl_seat", 1),
    ("wl_output", 4),
    ("zxdg_output_manager_v1", 3),
    ("zwlr_virtual_pointer_manager_v1", 2),
    ("zwp_virtual_keyboard_manager_v1", 1),
];

/// Check what the running compositor advertises against what this profile
/// needs. A profile is never inferred from these globals; it only narrows.
pub fn require_globals(profile: &Profile, globals: &[(String, u32)]) -> Result<()> {
    for (interface, version) in REQUIRED_GLOBALS {
        ensure!(globals.iter().any(|(name, v)| name == interface && v >= version),
            "{} does not provide {interface} version {version}, which Computer Control requires", profile.name);
    }
    ensure!(globals.iter().filter(|(name, _)| name == "wl_seat").count() == 1,
        "Computer Control requires exactly one {} input seat", profile.name);
    if profile.lock == LockSignal::HyprlandLockNotify {
        ensure!(globals.iter().any(|(name, _)| name == "hyprland_lock_notifier_v1"),
            "{} does not provide its lock notifier", profile.name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn globals(entries: &[(&str, u32)]) -> Vec<(String, u32)> {
        entries.iter().map(|(name, version)| (name.to_string(), *version)).collect()
    }
    const NIRI_GLOBALS: &[(&str, u32)] = &[("wl_compositor", 6), ("wl_seat", 9), ("wl_output", 4),
        ("zxdg_output_manager_v1", 3), ("zwlr_virtual_pointer_manager_v1", 2), ("zwp_virtual_keyboard_manager_v1", 1)];

    #[test]
    fn identifies_exactly_one_known_desktop() {
        for (value, desktop) in [("GNOME", Desktop::Gnome), ("ubuntu:GNOME", Desktop::Gnome), ("gnome", Desktop::Gnome),
            ("KDE", Desktop::Kde), ("plasma:KDE", Desktop::Kde), ("niri", Desktop::Niri), ("sway", Desktop::Sway),
            ("Hyprland", Desktop::Hyprland), ("labwc:wlroots", Desktop::Labwc), ("river", Desktop::River),
            ("Wayfire", Desktop::Wayfire), ("COSMIC", Desktop::Cosmic), ("niri:niri", Desktop::Niri)] {
            assert_eq!(identify(value).unwrap(), desktop, "{value}");
        }
        for value in ["", "XFCE", "wlroots", "not-GNOME", "KDE-other", "GNOME:KDE", "sway:niri", "niri-session", ":"] {
            assert!(identify(value).is_err(), "{value}");
        }
    }

    #[test]
    fn only_allow_listed_desktops_with_an_observable_lock_qualify() {
        assert_eq!(qualify(Desktop::Gnome).unwrap(), Path::Portal(Desktop::Gnome));
        assert_eq!(qualify(Desktop::Kde).unwrap(), Path::Portal(Desktop::Kde));
        let Path::VirtualInput(niri) = qualify(Desktop::Niri).unwrap() else { panic!("niri uses virtual input") };
        assert_eq!((niri.lock, niri.absolute_input, niri.capture),
            (LockSignal::CompositorLockedHint, AbsoluteInput::OutputBeforeTransform, CaptureMemory::LinearDmaBuf));
        for desktop in [Desktop::Sway, Desktop::River, Desktop::Labwc, Desktop::Wayfire, Desktop::Cosmic] {
            let error = qualify(desktop).unwrap_err().to_string();
            assert!(error.contains("see when the screen is locked"), "{error}");
        }
        assert!(qualify(Desktop::Hyprland).unwrap_err().to_string().contains("has not been qualified on Hyprland"));
    }

    #[test]
    fn every_allow_listed_desktop_has_an_observable_lock_signal() {
        for desktop in ALLOW_LIST {
            assert_ne!(lock_signal(*desktop), LockSignal::Unobservable);
            assert_ne!(lock_signal(*desktop), LockSignal::HyprlandLockNotify, "lock notifier is not implemented");
        }
    }

    #[test]
    fn wlroots_profiles_share_one_protocol_path() {
        for desktop in [Desktop::Sway, Desktop::Hyprland, Desktop::River, Desktop::Labwc, Desktop::Wayfire] {
            let Path::VirtualInput(profile) = path(desktop) else { panic!("{desktop:?}") };
            assert_eq!((profile.absolute_input, profile.capture), (AbsoluteInput::LogicalBox, CaptureMemory::System));
        }
        assert_eq!(path(Desktop::Cosmic), Path::Portal(Desktop::Cosmic));
    }

    #[test]
    fn advertised_globals_narrow_but_never_select_a_profile() {
        let Path::VirtualInput(niri) = path(Desktop::Niri) else { unreachable!() };
        let Path::VirtualInput(sway) = path(Desktop::Sway) else { unreachable!() };
        require_globals(&niri, &globals(NIRI_GLOBALS)).unwrap();
        require_globals(&sway, &globals(NIRI_GLOBALS)).unwrap();
        for missing in ["wl_output", "zxdg_output_manager_v1", "zwlr_virtual_pointer_manager_v1", "zwp_virtual_keyboard_manager_v1", "wl_seat"] {
            let reduced: Vec<_> = NIRI_GLOBALS.iter().copied().filter(|(name, _)| *name != missing).collect();
            assert!(require_globals(&niri, &globals(&reduced)).unwrap_err().to_string().contains(missing));
        }
        let old: Vec<_> = NIRI_GLOBALS.iter().map(|(name, version)| (*name, if *name == "zwlr_virtual_pointer_manager_v1" { 1 } else { *version })).collect();
        assert!(require_globals(&niri, &globals(&old)).is_err());
        let old_output: Vec<_> = NIRI_GLOBALS.iter().map(|(name, version)| (*name, if *name == "wl_output" { 3 } else { *version })).collect();
        assert!(require_globals(&niri, &globals(&old_output)).is_err());
        let mut two_seats = NIRI_GLOBALS.to_vec();
        two_seats.push(("wl_seat", 9));
        assert!(require_globals(&niri, &globals(&two_seats)).unwrap_err().to_string().contains("exactly one"));
        let Path::VirtualInput(hyprland) = path(Desktop::Hyprland) else { unreachable!() };
        assert!(require_globals(&hyprland, &globals(NIRI_GLOBALS)).is_err());
        let mut notifier = NIRI_GLOBALS.to_vec();
        notifier.push(("hyprland_lock_notifier_v1", 1));
        require_globals(&hyprland, &globals(&notifier)).unwrap();
    }
}
