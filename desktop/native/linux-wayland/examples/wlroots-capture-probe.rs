//! Portal capture and geometry acceptance for a prepared wlroots-family
//! profile, only inside the disposable container seat. It also checks that the
//! product entry point refuses this desktop before any chooser opens.
use amplefile_wayland::{
    capture::Capture,
    compositor::{self, Path},
    portal::SharedScreen,
    virtual_input::Input,
};
use anyhow::{ensure, Context, Result};
use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};
use sha2::{Digest, Sha256};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(
        std::env::var("AMPLEFILE_ISOLATED_WLROOTS_TEST").as_deref() == Ok("1"),
        "Use a disposable wlroots fixture"
    );
    let root = std::env::var("XDG_RUNTIME_DIR")?;
    ensure!(
        root.contains("amplefile-wlroots-test-")
            && std::env::var("SWAYSOCK")?.starts_with(&root)
            && std::env::var("DBUS_SESSION_BUS_ADDRESS")?.contains("unix:"),
        "Refusing the person's desktop"
    );
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() == 4, "Expected scale and background RGB hex");
    let scale: f64 = args[1].parse()?;
    let background: Vec<u8> = (0..3)
        .map(|i| u8::from_str_radix(&args[2][i * 2..i * 2 + 2], 16))
        .collect::<Result<_, _>>()?;
    let output_name = &args[3];

    // The product entry point refuses this desktop without opening a portal.
    let refusal = match SharedScreen::request(std::future::pending()).await {
        Ok(_) => anyhow::bail!("An unqualified desktop was admitted"),
        Err(error) => error.to_string(),
    };
    ensure!(refusal.contains("see when the screen is locked"), "Unexpected refusal: {refusal}");
    println!("PASS product entry point refuses this desktop before a chooser: {refusal}");

    let desktop = compositor::identify(&std::env::var("XDG_CURRENT_DESKTOP")?)?;
    let Path::VirtualInput(profile) = compositor::path(desktop) else {
        anyhow::bail!("Not a virtual-input profile")
    };
    gstreamer::init()?;
    let cast = Screencast::new().await?;
    let session = cast.create_session(Default::default()).await?;
    cast.select_sources(
        &session,
        SelectSourcesOptions::default()
            .set_sources(Some(SourceType::Monitor.into()))
            .set_multiple(false)
            .set_cursor_mode(CursorMode::Embedded)
            .set_persist_mode(PersistMode::DoNot),
    )
    .await?
    .response()?;
    let selection = cast.start(&session, None, Default::default()).await?.response()?;
    ensure!(selection.streams().len() == 1, "Select exactly one monitor");
    let stream = &selection.streams()[0];
    let position = stream.position().context("No monitor position")?;
    let size = stream.size().context("No monitor size")?;
    let fd = cast.open_pipe_wire_remote(&session, Default::default()).await?;
    let capture = Capture::portal(fd.into(), stream.pipe_wire_node_id()).await?;
    let expected = (
        (f64::from(size.0) * scale).round() as u32,
        (f64::from(size.1) * scale).round() as u32,
    );
    // The fixture window was just closed; allow the compositor a few frames
    // to repaint the bare background, then require every pixel to be exact.
    let mut attempt = 0;
    let frame = loop {
        let frame = capture.frame().await?;
        ensure!(
            (frame.info.width, frame.info.height) == expected,
            "Captured {}x{}, expected {:?} for logical {:?} at {scale}",
            frame.info.width,
            frame.info.height,
            expected,
            size
        );
        let png = frame.png()?;
        let mut decoder = png::Decoder::new(std::io::Cursor::new(&png)).read_info()?;
        let mut rgba = vec![0; decoder.output_buffer_size().context("Invalid PNG size")?];
        let decoded = decoder.next_frame(&mut rgba)?;
        let rgba = &rgba[..decoded.buffer_size()];
        ensure!(
            format!("{:x}", Sha256::digest(rgba)) == frame.info.sha256,
            "PNG and raw pixels disagree"
        );
        let exact = rgba
            .chunks_exact(4)
            .filter(|pixel| pixel[..3] == background[..] && pixel[3] == 255)
            .count();
        let total = rgba.len() / 4;
        std::fs::write(format!("{root}/capture.png"), &png)?;
        if exact == total {
            break frame;
        }
        attempt += 1;
        ensure!(
            attempt < 30,
            "{} of {total} pixels differ from the background; first pixel {:?}",
            total - exact,
            &rgba[..4]
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    println!(
        "PASS portal capture {}x{} (logical {:?} at {scale}), every pixel exactly #{}",
        frame.info.width, frame.info.height, size, args[2]
    );

    // The granted stream must match exactly one output's logical geometry.
    let mut input = Input::new(&profile, position, size, (frame.info.width, frame.info.height))?;
    ensure!(
        Input::new(&profile, position, (size.0 + 1, size.1), (frame.info.width, frame.info.height)).is_err(),
        "A mismatched logical geometry was admitted"
    );
    // Adding an unrelated output leaves the selected one valid; changing the
    // selected output's scale invalidates the grant.
    let sway = |command: &[&str]| -> Result<()> {
        let status = std::process::Command::new("swaymsg").args(command).status()?;
        ensure!(status.success(), "swaymsg {command:?} failed");
        std::thread::sleep(std::time::Duration::from_millis(300));
        Ok(())
    };
    sway(&["create_output"])?;
    sway(&["output", "HEADLESS-2", "position", "4000", "0"])?;
    input.dispatch().context("An unrelated new output invalidated the grant")?;
    println!("PASS unrelated hot-plugged output keeps the selected output's grant");
    sway(&["output", output_name, "scale", "2"])?;
    let error = input.dispatch().expect_err("A scale change kept the grant").to_string();
    ensure!(error.contains("geometry changed"), "Unexpected error: {error}");
    println!("PASS selected output scale change invalidates input: {error}");
    session.close().await.ok();
    Ok(())
}
