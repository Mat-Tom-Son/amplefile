//! Real protocol acceptance for a prepared wlroots-family profile, only inside
//! the disposable container seat of scripts/linux-wlroots-probe. It uses the
//! profile directly: the allow-list gate is checked separately (refusal).
use amplefile_wayland::{
    compositor::{self, Path},
    virtual_input::Input,
};
use anyhow::{ensure, Context, Result};
use std::io::BufRead;

fn main() -> Result<()> {
    ensure!(
        std::env::var("AMPLEFILE_ISOLATED_WLROOTS_TEST").as_deref() == Ok("1"),
        "Use a disposable wlroots fixture"
    );
    let root = std::env::var("XDG_RUNTIME_DIR")?;
    ensure!(
        root.contains("amplefile-wlroots-test-")
            && std::env::var("SWAYSOCK")?.starts_with(&root),
        "Refusing the person's desktop"
    );
    let desktop = compositor::identify(&std::env::var("XDG_CURRENT_DESKTOP")?)?;
    let Path::VirtualInput(profile) = compositor::path(desktop) else {
        anyhow::bail!("Not a virtual-input profile")
    };
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() >= 6, "Expected mode and logical x y width height");
    let number = |index: usize| -> Result<i32> { args[index].parse().context("Invalid geometry") };
    let (position, size) = ((number(2)?, number(3)?), (number(4)?, number(5)?));
    let scale: f64 = args.get(6).map(|s| s.parse()).transpose()?.unwrap_or(1.0);
    let pixels = (
        (f64::from(size.0) * scale).round() as u32,
        (f64::from(size.1) * scale).round() as u32,
    );
    let mut input = Input::new(&profile, position, size, pixels)?;
    let mapping = input.regions()?[0].mapping_id.clone().context("No mapping")?;
    match args[1].as_str() {
        "type" => {
            input.begin_sequence()?;
            input.click(&mapping, 150.0, 120.0, 272, 1)?;
            std::thread::sleep(std::time::Duration::from_millis(150));
            input.click(&mapping, 150.0, 220.0, 272, 1)?;
            input.type_text("Wlroots input works!")?;
            input.shortcut(&["CTRL".into(), "a".into()])?;
            input.type_text("Exact final bytes")?;
            input.end_sequence();
            input.dispatch()?;
            ensure!(
                input.move_absolute(&mapping, -1.0, 20.0).is_err()
                    && input
                        .move_absolute(&mapping, f64::from(size.0), 20.0)
                        .is_err(),
                "Outside-monitor input was admitted"
            );
            println!("PASS {} output-bound pointer, keymap typing and shortcut dispatch", profile.name);
        }
        // Hold one connection while the fixture changes outputs, then report
        // whether this grant survived. Output changes must invalidate it.
        "hold" => {
            println!("READY");
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line)?;
            match input.dispatch() {
                Ok(()) => println!("VALID"),
                Err(error) => println!("INVALID {error}"),
            }
        }
        other => anyhow::bail!("Unknown mode {other}"),
    }
    Ok(())
}
