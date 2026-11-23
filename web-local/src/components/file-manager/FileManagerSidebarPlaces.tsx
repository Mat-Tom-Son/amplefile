import "./file-manager-places.css";
import type { DriveRow } from "./file-manager-drives";
import { DriveGlyph, EjectGlyph, TrashGlyph } from "./file-manager-glyphs";

/**
 * The sidebar's Trash row and Drives section (docs/product-model.md, "The
 * file manager window"). The Trash opens the system Trash in the list area;
 * each drive opens in the computer place at its mount path, and an ejectable
 * one has an Eject button beside it.
 */

export function SidebarTrashRow({ current, onOpen }: { current: boolean; onOpen: () => void }) {
  return <li><button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}`} aria-current={current ? "page" : undefined} onClick={onOpen}>
    <span className="fm-sidebar-icon"><TrashGlyph /></span>
    <span className="fm-sidebar-name">Trash</span>
  </button></li>;
}

export function SidebarDrives({ rows, currentKey, ejecting, onOpen, onEject }: {
  rows: readonly DriveRow[];
  /** The row holding the folder shown, if any. */
  currentKey: string | null;
  /** The drive being ejected, whose button waits. */
  ejecting: string | null;
  onOpen: (row: DriveRow) => void;
  onEject: (row: DriveRow) => void;
}) {
  return <>
    <div className="fm-sidebar-heading"><span id="fm-drives-heading">Drives</span></div>
    <ul className="fm-sidebar-list" aria-labelledby="fm-drives-heading">
      {rows.map((row) => {
        const current = currentKey === row.key;
        return <li key={row.key} className={`fm-drive${row.ejectable ? " is-ejectable" : ""}`}>
          <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}`} aria-current={current ? "page" : undefined} title={row.detail ? `${row.name}\n${row.detail}` : row.name} onClick={() => onOpen(row)}>
            <span className="fm-sidebar-icon"><DriveGlyph removable={row.ejectable} /></span>
            <span className="fm-sidebar-name">{row.name}</span>
          </button>
          {row.ejectable ? <button type="button" className="fm-eject" aria-label={`Eject ${row.name}`} title={`Eject “${row.name}”`} disabled={ejecting === row.key} onClick={() => onEject(row)}><EjectGlyph /></button> : null}
        </li>;
      })}
    </ul>
  </>;
}
