//! Real protocol acceptance on a disposable nested compositor only.
use amplefile_wayland::{
    compositor::{self, Path},
    virtual_input::Input,
};
use anyhow::{ensure, Context, Result};
fn main() -> Result<()> {
    ensure!(
        std::env::var("AMPLEFILE_ISOLATED_NIRI_TEST").as_deref() == Ok("1"),
        "Use a disposable niri fixture"
    );
    let root = std::env::var("XDG_RUNTIME_DIR")?;
    ensure!(
        root.contains("amplefile-niri-test-") && std::env::var("NIRI_SOCKET")?.starts_with(&root),
        "Refusing the person's desktop"
    );
    let output: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("{root}/output.json"))?)?;
    let logical = output
        .as_object()
        .context("No outputs")?
        .values()
        .next()
        .context("No output")?
        .get("logical")
        .context("No logical output")?;
    let width = logical["width"].as_i64().context("No width")? as i32;
    let height = logical["height"].as_i64().context("No height")? as i32;
    let Path::VirtualInput(profile) = compositor::qualify(compositor::identify("niri")?)? else {
        anyhow::bail!("niri uses virtual input")
    };
    let mut input = Input::new(&profile, (0, 0), (width, height), (width as u32, height as u32))?;
    let mapping = input.regions()?[0].mapping_id.clone().unwrap();
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--click") {
        input.click(&mapping, args[2].parse()?, args[3].parse()?, 272, 1)?;
        input.end_sequence();
        input.dispatch()?;
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--key") {
        input.shortcut(&args[2..])?;
        input.end_sequence();
        input.dispatch()?;
        return Ok(());
    }
    input.begin_sequence()?;
    input.click(&mapping, 150.0, 120.0, 272, 1)?;
    std::thread::sleep(std::time::Duration::from_millis(150));
    input.click(&mapping, 150.0, 220.0, 272, 1)?;
    input.type_text("Niri input works!")?;
    input.shortcut(&["CTRL".into(), "a".into()])?;
    input.type_text("Exact final bytes")?;
    input.end_sequence();
    input.dispatch()?;
    ensure!(
        input.move_absolute(&mapping, -1.0, 20.0).is_err(),
        "Outside-monitor input was admitted"
    );
    println!("PASS niri native input protocol, keymap typing and shortcut dispatch");
    Ok(())
}
