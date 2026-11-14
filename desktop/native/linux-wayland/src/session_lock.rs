//! For compositors that publish their own confirmed lock state as logind's
//! LockedHint (niri; see `compositor::LockSignal::CompositorLockedHint`).
//! Require the current user's active Wayland session and revoke on lock, VT
//! switch or loss. A locker client that never sets the hint makes this signal
//! meaningless, which is why such desktops are not admitted at all.
use anyhow::{ensure, Context, Result};
use futures_util::StreamExt;
use tokio::sync::oneshot;
use zbus::zvariant::OwnedObjectPath;

pub async fn monitor_logind(ready: oneshot::Sender<Result<()>>) {
    let mut ready = Some(ready);
    let result = async {
        let id = std::env::var("XDG_SESSION_ID").context("Screen sharing requires XDG_SESSION_ID for lock monitoring")?;
        ensure!(!id.is_empty() && id.len() <= 128,"Invalid login session identifier");
        let connection = zbus::Connection::system().await?;
        let manager = zbus::Proxy::new(&connection,"org.freedesktop.login1","/org/freedesktop/login1","org.freedesktop.login1.Manager").await?;
        let path:OwnedObjectPath = manager.call("GetSession",&(id,)).await?;
        let session: zbus::Proxy<'_> = zbus::proxy::Builder::new(&connection).destination("org.freedesktop.login1")?.path(path.as_str())?.interface("org.freedesktop.login1.Session")?.cache_properties(zbus::proxy::CacheProperties::No).build().await?;
        let user:(u32,OwnedObjectPath) = session.get_property("User").await?;
        ensure!(user.0 == unsafe {libc::geteuid()},"Login session belongs to another user");
        ensure!(session.get_property::<String>("Type").await? == "wayland","Login session is not Wayland");
        let properties = zbus::fdo::PropertiesProxy::new(&connection,"org.freedesktop.login1",path.as_str()).await?;
        let mut changes = properties.receive_properties_changed().await?;
        let mut owners = session.receive_owner_changed().await?;
        ensure!(!session.get_property::<bool>("LockedHint").await?,"Unlock the desktop before sharing");
        ensure!(session.get_property::<bool>("Active").await?,"Activate the login session before sharing");
        let _ = ready.take().unwrap().send(Ok(()));
        loop {
            tokio::select! {
                _ = owners.next() => anyhow::bail!("Login session service changed"),
                change = changes.next() => {
                    let change = change.context("Login session monitoring ended")?;
                    let args = change.args()?;
                    if args.interface_name().as_str() != "org.freedesktop.login1.Session" {continue;}
                    if args.changed_properties().contains_key("LockedHint") || args.changed_properties().contains_key("Active")
                        || args.invalidated_properties().iter().any(|name| *name == "LockedHint" || *name == "Active") {
                        // A fresh typed read also handles invalidated properties.
                        ensure!(!session.get_property::<bool>("LockedHint").await?,"Desktop was locked");
                        ensure!(session.get_property::<bool>("Active").await?,"Login session became inactive");
                    }
                }
            }
        }
    }.await;
    if let Some(ready) = ready {
        let _ = ready.send(result);
    }
}
