import type { ConnectedFolderSummary } from "../../types";
import type { QuickMenuState } from "./file-manager-menus";
import type { ActionMenuState } from "./useFileManagerMenus";

/** The window's own small menu at the pointer (everywhere but the Mac, which shows the native one). */
export function QuickMenu({ menu, onClose }: { menu: QuickMenuState; onClose: () => void }) {
  return <>
    <div className="fm-menu-back" onClick={() => { menu.run(null); onClose(); }} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
    <div className="fm-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      {menu.items.map((item, index) => item.command === "-"
        ? <div key={`-${index}`} className="fm-menu-sep" role="separator" />
        : <button key={item.command} type="button" className="fm-menu-i" role="menuitem" autoFocus={index === 0} onClick={() => { const { run } = menu; onClose(); run(item.command); }}>{item.label}</button>)}
    </div>
  </>;
}

/** The window's own Action menu: the Connected Folder's commands, then Settings. */
export function ActionMenu({ menu, onClose, onCommand }: { menu: ActionMenuState; onClose: () => void; onCommand: (command: string, target: ConnectedFolderSummary | null) => void }) {
  const run = (command: string, target: ConnectedFolderSummary | null) => { onClose(); onCommand(command, target); };
  return <>
    <div className="fm-menu-back" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
    <div className="fm-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      {menu.target ? <>
        {menu.sidebar ? <>
          <button type="button" className="fm-menu-i" role="menuitem" autoFocus onClick={() => run("open-in-new-tab", menu.target)}>Open in New Tab</button>
          {menu.newWindow ? <button type="button" className="fm-menu-i" role="menuitem" onClick={() => run("open-in-new-window", menu.target)}>Open in New Window</button> : null}
          <div className="fm-menu-sep" />
        </> : null}
        <button type="button" className="fm-menu-i" role="menuitem" autoFocus={!menu.sidebar} onClick={() => run("customize", menu.target)}>Customize Connected Folder</button>
        <button type="button" className="fm-menu-i" role="menuitem" onClick={() => run("organize", menu.target)}>Organize</button>
        <button type="button" className="fm-menu-i" role="menuitem" onClick={() => run("skills", menu.target)}>Skills &amp; Extensions…</button>
        <div className="fm-menu-sep" />
        <button type="button" className="fm-menu-i" role="menuitem" onClick={() => run("remove-connected-folder", menu.target)}>{menu.target.location.storage === "linked" ? "Disconnect…" : "Delete Connected Folder…"}</button>
      </> : null}
      <button type="button" className="fm-menu-i" role="menuitem" autoFocus={!menu.target} onClick={() => run("settings", null)}>Settings…</button>
    </div>
  </>;
}
