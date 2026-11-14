//! A capture-only child of portal-capture-diagnostic. No input is dispatched.
use amplefile_wayland::{
    capture::Capture,
    compositor::{self, Path},
    virtual_input::Input,
};
use anyhow::{ensure, Context, Result};
use std::os::fd::{FromRawFd, OwnedFd};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(
        std::env::var("AMPLEFILE_LIVE_SHARE_DIAGNOSTIC").as_deref() == Ok("1"),
        "Use the explicit screen-sharing diagnostic"
    );
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) } == 0,
        "Cannot bind diagnostic lifetime"
    );
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 7,
        "Expected inherited fd, node, logical geometry"
    );
    let fd: i32 = args[1].parse()?;
    ensure!(fd >= 3, "Invalid inherited PipeWire fd");
    gstreamer::init()?;
    let capture =
        Capture::portal_linear(unsafe { OwnedFd::from_raw_fd(fd) }, args[2].parse()?).await?;
    let frame = capture.frame().await?;
    let position = (args[3].parse()?, args[4].parse()?);
    let size = (args[5].parse()?, args[6].parse()?);
    let png = frame.png()?;
    ensure!(png.len() > 100, "Empty PNG");
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&png)).read_info()?;
    let mut rgba = vec![0; decoder.output_buffer_size().context("Invalid PNG size")?];
    let decoded = decoder.next_frame(&mut rgba)?;
    let rgba = &rgba[..decoded.buffer_size()];
    ensure!(
        rgba.chunks_exact(4).all(|pixel| pixel[3] == 255),
        "Unexpected screen alpha"
    );
    ensure!(
        rgba.chunks_exact(4).any(|pixel| pixel[..3] != rgba[..3]),
        "Capture diagnostic expected a nonblank visible desktop"
    );
    use sha2::{Digest, Sha256};
    ensure!(
        format!("{:x}", Sha256::digest(rgba)) == frame.info.sha256,
        "PNG and raw pixels disagree"
    );
    let Path::VirtualInput(profile) = compositor::path(compositor::identify("niri")?) else {
        anyhow::bail!("niri uses virtual input")
    };
    let _input = Input::new(&profile, position, size, (frame.info.width, frame.info.height))?;
    println!("PASS GPU capture {}x{}, logical {:?}, valid PNG, output-bound input mapping; no input sent",frame.info.width,frame.info.height,size);
    Ok(())
}
