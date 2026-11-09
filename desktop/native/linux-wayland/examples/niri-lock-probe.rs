use amplefile_wayland::session_lock::monitor_niri;
use anyhow::{ensure, Result};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let root = std::env::var("XDG_RUNTIME_DIR")?;
    ensure!(
        std::env::var("AMPLEFILE_ISOLATED_NIRI_TEST").as_deref() == Ok("1")
            && root.contains("amplefile-niri-test-")
            && std::env::var("DBUS_SYSTEM_BUS_ADDRESS")?.contains(&root),
        "Refusing the person's session"
    );
    let (ready, subscribed) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(monitor_niri(ready));
    tokio::time::timeout(std::time::Duration::from_secs(3), subscribed).await???;
    let connection = zbus::Connection::system().await?;
    let proxy = zbus::Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1/session/amplefiletest",
        "org.freedesktop.login1.Session",
    )
    .await?;
    let _: () = proxy.call("SetLockedHint", &(true,)).await?;
    tokio::time::timeout(std::time::Duration::from_secs(3), task).await??;
    println!("PASS niri logind lock monitoring revokes an active grant");
    Ok(())
}
