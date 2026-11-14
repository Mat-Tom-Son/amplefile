//! AmpleFile's X11 clipboard helper.
//!
//! `amplefile-clipboard serve [--max-seconds N]` reads targets and their bytes
//! from stdin (see `frames`), takes the X `CLIPBOARD` selection, prints
//! `owned` (or `unavailable <reason>` and exits 2), and serves every target
//! until another client takes the selection, stdin reaches end of file (the
//! app quit or crashed), the parent dies, or the time bound passes. Electron's
//! own clipboard can offer only one custom format per write; this process
//! offers them all in one selection.
//!
//! `amplefile-clipboard read TARGET...` converts the current `CLIPBOARD` to
//! each target and writes the results to stdout. `TARGETS` comes back as
//! newline-separated atom names.

mod frames;

use std::collections::HashMap;
use std::io::{self, BufWriter, Read, Write};
use std::process::exit;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, Property,
    SelectionNotifyEvent, SelectionRequestEvent, Timestamp, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT, CURRENT_TIME, NONE};

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        CLIPBOARD,
        TARGETS,
        TIMESTAMP,
        MULTIPLE,
        INCR,
        ATOM_PAIR,
        UTF8_STRING,
        TEXT,
        AMPLEFILE_CLIPBOARD_TIME: b"_AMPLEFILE_CLIPBOARD_TIME",
        AMPLEFILE_CLIPBOARD_READ: b"_AMPLEFILE_CLIPBOARD_READ",
    }
}

/// How long a selection is served at most when the app does not say.
const DEFAULT_MAX_SECONDS: u64 = 24 * 60 * 60;
/// Incremental transfers left unfinished this long are dropped.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TRANSFERS: usize = 16;
/// One `read` call, every target together, ends within this.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("read") if args.len() > 1 => read(&args[1..]),
        _ => {
            eprintln!("usage: amplefile-clipboard serve [--max-seconds N] < request | amplefile-clipboard read TARGET...");
            exit(64);
        }
    };
    if let Err(error) = outcome {
        eprintln!("amplefile-clipboard: {error}");
        exit(1);
    }
}

/// Ends this process when its parent does, so a crashed app leaves no owner behind.
fn exit_with_parent() {
    extern "C" {
        fn prctl(option: i32, ...) -> i32;
    }
    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGTERM: i32 = 15;
    // SAFETY: prctl(PR_SET_PDEATHSIG, signal) takes one integer argument and touches no memory.
    unsafe {
        prctl(PR_SET_PDEATHSIG, SIGTERM as std::ffi::c_ulong);
    }
}

fn max_seconds(args: &[String]) -> std::result::Result<u64, String> {
    match args {
        [] => Ok(DEFAULT_MAX_SECONDS),
        [flag, value] if flag == "--max-seconds" => value.parse::<u64>().ok().filter(|seconds| *seconds > 0).ok_or_else(|| "--max-seconds needs a positive number".into()),
        _ => Err("unknown serve arguments".into()),
    }
}

struct Offer {
    target: Atom,
    /// The property type the bytes are sent as: the target itself, or `UTF8_STRING` for `TEXT`.
    kind: Atom,
    data: Arc<[u8]>,
}

struct Transfer {
    window: Window,
    property: Atom,
    kind: Atom,
    data: Arc<[u8]>,
    offset: usize,
    started: Instant,
}

fn serve(args: &[String]) -> Result<()> {
    exit_with_parent();
    let bound = max_seconds(args)?;
    let entries = frames::read_entries(&mut io::stdin().lock())?;
    let (conn, screen_number) = match x11rb::connect(None) {
        Ok(connection) => connection,
        Err(error) => unavailable(format!("no X display: {error}")),
    };
    let atoms = Atoms::new(&conn)?.reply()?;
    let mut offers = Vec::with_capacity(entries.len());
    for entry in entries {
        let target = conn.intern_atom(false, entry.target.as_bytes())?.reply()?.atom;
        let kind = if target == atoms.TEXT { atoms.UTF8_STRING } else { target };
        offers.push(Offer { target, kind, data: entry.data.into() });
    }
    let window = create_window(&conn, screen_number)?;
    let acquired = server_time(&conn, window, atoms.AMPLEFILE_CLIPBOARD_TIME)?;
    conn.set_selection_owner(window, atoms.CLIPBOARD, acquired)?;
    if conn.get_selection_owner(atoms.CLIPBOARD)?.reply()?.owner != window {
        unavailable("the X server did not give the clipboard to the helper".into());
    }
    println!("owned");
    io::stdout().flush()?;

    // The app keeps stdin open while it lives: end of file means it quit or crashed.
    thread::spawn(|| {
        let mut stdin = io::stdin().lock();
        let mut sink = [0u8; 4096];
        loop {
            match stdin.read(&mut sink) {
                Ok(0) | Err(_) => exit(0),
                Ok(_) => {}
            }
        }
    });
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(bound));
        exit(0);
    });

    let chunk = (conn.maximum_request_bytes() / 4).clamp(4096, 256 * 1024);
    let mut transfers: Vec<Transfer> = Vec::new();
    loop {
        let event = conn.wait_for_event()?;
        transfers.retain(|transfer| transfer.started.elapsed() < TRANSFER_TIMEOUT);
        match event {
            Event::SelectionClear(clear) if clear.selection == atoms.CLIPBOARD => return Ok(()),
            Event::SelectionRequest(request) => {
                answer(&conn, &atoms, &offers, acquired, chunk, &mut transfers, &request)?;
            }
            Event::PropertyNotify(notify) if notify.state == Property::DELETE => {
                if let Some(index) = transfers.iter().position(|transfer| transfer.window == notify.window && transfer.property == notify.atom) {
                    let transfer = &mut transfers[index];
                    let end = (transfer.offset + chunk).min(transfer.data.len());
                    let piece = &transfer.data[transfer.offset..end];
                    conn.change_property8(PropMode::REPLACE, transfer.window, transfer.property, transfer.kind, piece)?;
                    if piece.is_empty() {
                        let window = transfer.window;
                        transfers.remove(index);
                        if !transfers.iter().any(|other| other.window == window) {
                            conn.change_window_attributes(window, &ChangeWindowAttributesAux::new().event_mask(EventMask::NO_EVENT))?;
                        }
                    } else {
                        transfer.offset = end;
                        transfer.started = Instant::now();
                    }
                    conn.flush()?;
                }
            }
            Event::DestroyNotify(destroyed) => transfers.retain(|transfer| transfer.window != destroyed.window),
            // A requestor that vanished mid-reply makes its property writes fail; nothing else depends on them.
            _ => {}
        }
    }
}

/// Tells the app the helper cannot own the clipboard here, so it falls back to Electron's own write.
fn unavailable(reason: String) -> ! {
    println!("unavailable {reason}");
    let _ = io::stdout().flush();
    exit(2);
}

fn create_window(conn: &RustConnection, screen_number: usize) -> Result<Window> {
    let window = conn.generate_id()?;
    let root = conn.setup().roots[screen_number].root;
    conn.create_window(
        COPY_DEPTH_FROM_PARENT, window, root, -10, -10, 1, 1, 0, WindowClass::INPUT_ONLY, COPY_FROM_PARENT,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )?;
    Ok(window)
}

/// A real server timestamp, as ICCCM asks owners to use: the time of a zero-length property append.
fn server_time(conn: &RustConnection, window: Window, property: Atom) -> Result<Timestamp> {
    conn.change_property8(PropMode::APPEND, window, property, AtomEnum::STRING, &[])?;
    conn.flush()?;
    loop {
        if let Event::PropertyNotify(notify) = conn.wait_for_event()? {
            if notify.window == window && notify.atom == property {
                return Ok(notify.time);
            }
        }
    }
}

/// Answers one conversion request, then tells the requestor.
fn answer(
    conn: &RustConnection, atoms: &Atoms, offers: &[Offer], acquired: Timestamp, chunk: usize,
    transfers: &mut Vec<Transfer>, request: &SelectionRequestEvent,
) -> Result<()> {
    // Obsolete clients name no property and expect the target's name to be used.
    let property = if request.property == NONE { request.target } else { request.property };
    let current = request.time == CURRENT_TIME || request.time >= acquired;
    let converted = request.selection == atoms.CLIPBOARD && current && if request.target == atoms.MULTIPLE {
        request.property != NONE && convert_multiple(conn, atoms, offers, acquired, chunk, request.requestor, property)?
    } else {
        convert(conn, atoms, offers, acquired, chunk, Some(transfers), request.requestor, request.target, property)?
    };
    let notify = SelectionNotifyEvent {
        response_type: SELECTION_NOTIFY_EVENT,
        sequence: 0,
        time: request.time,
        requestor: request.requestor,
        selection: request.selection,
        target: request.target,
        property: if converted { property } else { NONE },
    };
    conn.send_event(false, request.requestor, EventMask::NO_EVENT, notify)?;
    conn.flush()?;
    Ok(())
}

/// Writes one target to the requestor's property; large data starts an incremental transfer when `transfers` allows it.
#[allow(clippy::too_many_arguments)]
fn convert(
    conn: &RustConnection, atoms: &Atoms, offers: &[Offer], acquired: Timestamp, chunk: usize,
    transfers: Option<&mut Vec<Transfer>>, requestor: Window, target: Atom, property: Atom,
) -> Result<bool> {
    if target == atoms.TARGETS {
        let mut list = vec![atoms.TARGETS, atoms.TIMESTAMP, atoms.MULTIPLE];
        list.extend(offers.iter().map(|offer| offer.target));
        conn.change_property32(PropMode::REPLACE, requestor, property, AtomEnum::ATOM, &list)?;
        return Ok(true);
    }
    if target == atoms.TIMESTAMP {
        conn.change_property32(PropMode::REPLACE, requestor, property, AtomEnum::INTEGER, &[acquired])?;
        return Ok(true);
    }
    let Some(offer) = offers.iter().find(|offer| offer.target == target) else { return Ok(false) };
    if offer.data.len() <= chunk {
        conn.change_property8(PropMode::REPLACE, requestor, property, offer.kind, &offer.data)?;
        return Ok(true);
    }
    let Some(transfers) = transfers else { return Ok(false) };
    if transfers.len() >= MAX_TRANSFERS {
        return Ok(false);
    }
    transfers.retain(|transfer| !(transfer.window == requestor && transfer.property == property));
    conn.change_window_attributes(requestor, &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY))?;
    conn.change_property32(PropMode::REPLACE, requestor, property, atoms.INCR, &[offer.data.len() as u32])?;
    transfers.push(Transfer { window: requestor, property, kind: offer.kind, data: offer.data.clone(), offset: 0, started: Instant::now() });
    Ok(true)
}

/// ICCCM `MULTIPLE`: an `ATOM_PAIR` list of (target, property); failed pairs are rewritten with `None`.
fn convert_multiple(
    conn: &RustConnection, atoms: &Atoms, offers: &[Offer], acquired: Timestamp, chunk: usize, requestor: Window, property: Atom,
) -> Result<bool> {
    let reply = conn.get_property(false, requestor, property, AtomEnum::ANY, 0, 1024)?.reply()?;
    let Some(values) = reply.value32() else { return Ok(false) };
    let mut pairs: Vec<u32> = values.collect();
    let mut changed = false;
    for pair in pairs.chunks_mut(2) {
        if pair.len() < 2 || pair[0] == atoms.MULTIPLE || pair[1] == NONE
            || !convert(conn, atoms, offers, acquired, chunk, None, requestor, pair[0], pair[1])? {
            pair[0] = NONE;
            changed = true;
        }
    }
    if changed {
        conn.change_property32(PropMode::REPLACE, requestor, property, reply.type_, &pairs)?;
    }
    Ok(true)
}

fn read(targets: &[String]) -> Result<()> {
    exit_with_parent();
    if targets.len() > frames::MAX_TARGETS || targets.iter().any(|target| !frames::valid_target_name(target.as_bytes())) {
        return Err("invalid targets".into());
    }
    thread::spawn(|| {
        thread::sleep(READ_TIMEOUT);
        eprintln!("amplefile-clipboard: the clipboard owner did not answer in time");
        exit(3);
    });
    let (conn, screen_number) = x11rb::connect(None)?;
    let atoms = Atoms::new(&conn)?.reply()?;
    let window = create_window(&conn, screen_number)?;
    let property = atoms.AMPLEFILE_CLIPBOARD_READ;
    let mut names: HashMap<Atom, String> = HashMap::new();
    let mut results = Vec::with_capacity(targets.len());
    for name in targets {
        let target = conn.intern_atom(false, name.as_bytes())?.reply()?.atom;
        let mut value = fetch(&conn, &atoms, window, target, property)?;
        if target == atoms.TARGETS {
            value = match value {
                Some(bytes) => Some(atom_names(&conn, &bytes, &mut names)?),
                None => None,
            };
        }
        results.push((name.clone(), value));
    }
    let mut output = BufWriter::new(io::stdout().lock());
    frames::write_results(&mut output, &results)?;
    Ok(())
}

/// Converts the clipboard to one target; `None` when the owner refuses or there is no owner.
fn fetch(conn: &RustConnection, atoms: &Atoms, window: Window, target: Atom, property: Atom) -> Result<Option<Vec<u8>>> {
    conn.delete_property(window, property)?;
    conn.convert_selection(window, atoms.CLIPBOARD, target, property, CURRENT_TIME)?;
    conn.flush()?;
    loop {
        if let Event::SelectionNotify(notify) = conn.wait_for_event()? {
            if notify.requestor != window || notify.selection != atoms.CLIPBOARD {
                continue;
            }
            if notify.property == NONE {
                return Ok(None);
            }
            let (kind, first) = take_property(conn, window, property)?;
            if kind != atoms.INCR {
                return Ok(Some(first));
            }
            let mut data = Vec::new();
            loop {
                if let Event::PropertyNotify(change) = conn.wait_for_event()? {
                    if change.window != window || change.atom != property || change.state != Property::NEW_VALUE {
                        continue;
                    }
                    let (_, piece) = take_property(conn, window, property)?;
                    if piece.is_empty() {
                        return Ok(Some(data));
                    }
                    data.extend(piece);
                }
            }
        }
    }
}

/// Reads and deletes a property of any type and format, returning its type and bytes (32-bit items in native order).
fn take_property(conn: &RustConnection, window: Window, property: Atom) -> Result<(Atom, Vec<u8>)> {
    let mut data = Vec::new();
    let mut offset = 0u32;
    loop {
        let reply = conn.get_property(false, window, property, AtomEnum::ANY, offset, 1 << 20)?.reply()?;
        let kind = reply.type_;
        data.extend_from_slice(&reply.value);
        // Offsets count 32-bit units; only the last piece can end mid-unit.
        offset += reply.value.len() as u32 / 4;
        if reply.bytes_after == 0 {
            conn.delete_property(window, property)?;
            conn.flush()?;
            return Ok((kind, data));
        }
    }
}

fn atom_names(conn: &RustConnection, bytes: &[u8], names: &mut HashMap<Atom, String>) -> Result<Vec<u8>> {
    let mut list = Vec::new();
    for item in bytes.chunks_exact(4) {
        let atom = u32::from_ne_bytes([item[0], item[1], item[2], item[3]]);
        if !names.contains_key(&atom) {
            let name = String::from_utf8_lossy(&conn.get_atom_name(atom)?.reply()?.name).into_owned();
            names.insert(atom, name);
        }
        list.push(names[&atom].clone());
    }
    Ok(list.join("\n").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_takes_an_optional_positive_bound() {
        assert_eq!(max_seconds(&[]), Ok(DEFAULT_MAX_SECONDS));
        assert_eq!(max_seconds(&["--max-seconds".into(), "5".into()]), Ok(5));
        assert!(max_seconds(&["--max-seconds".into(), "0".into()]).is_err());
        assert!(max_seconds(&["--other".into()]).is_err());
    }
}
