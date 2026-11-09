//! Opt-in live capture diagnostics. The real portal chooser grants one display;
//! keep that grant only while capture children run, then close on EOF or Stop.
use anyhow::{ensure, Context, Result};
use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};
use std::{os::fd::AsRawFd, path::PathBuf, process::Stdio};
use tokio::io::{AsyncBufReadExt, BufReader};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(
        std::env::var("AMPLEFILE_LIVE_SHARE_DIAGNOSTIC").as_deref() == Ok("1"),
        "Set the explicit live diagnostic flag"
    );
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
    let selected = cast
        .start(&session, None, Default::default())
        .await?
        .response()?;
    ensure!(selected.streams().len() == 1, "Select one display");
    let stream = &selected.streams()[0];
    let position = stream.position().context("No monitor position")?;
    let size = stream.size().context("No monitor size")?;
    let node = stream.pipe_wire_node_id();
    println!("Portal selected a display. Type capture to test, or stop to end sharing.");
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim() == "stop" {
            break;
        }
        if line.trim() != "capture" {
            continue;
        }
        let fd = cast
            .open_pipe_wire_remote(&session, Default::default())
            .await?;
        let raw = fd.as_raw_fd();
        ensure!(
            unsafe { libc::fcntl(raw, libc::F_SETFD, 0) } == 0,
            "Cannot pass the granted fd"
        );
        let executable: PathBuf = std::env::current_exe()?.with_file_name("capture-diagnostic");
        let output = tokio::task::spawn_blocking(move || {
            let output = std::process::Command::new(executable)
                .args([
                    raw.to_string(),
                    node.to_string(),
                    position.0.to_string(),
                    position.1.to_string(),
                    size.0.to_string(),
                    size.1.to_string(),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            drop(fd);
            output
        })
        .await??;
        print!("{}", String::from_utf8_lossy(&output.stdout));
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        println!("Capture child exit: {}", output.status);
    }
    session.close().await?;
    println!("Sharing closed");
    Ok(())
}
