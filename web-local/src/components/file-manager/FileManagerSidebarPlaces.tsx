import type { MouseEvent } from "react";

import "./file-manager-places.css";
import type { DriveRow, MountableVolume } from "./file-manager-drives";
import { DriveGlyph, EjectGlyph, TrashGlyph } from "./file-manager-glyphs";

/**
 * The sidebar's Trash row and Drives section (docs/product-model.md, "The
 * file manager window"). The Trash opens the system Trash in the list area;
 * each drive opens in the computer place at its mount path, and an ejectable
 * one has an Eject button beside it.
 */

/** A sidebar row's click handlers: its own click, and ⌘-click (Ctrl-click) or a middle click for a new tab. */
export interface SidebarOpenProps {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  onAuxClick?: (event: MouseEvent<HTMLElement>) => void;
}

export function SidebarTrashRow({ current, openProps }: { current: boolean; openProps: SidebarOpenProps }) {
  return <li><button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}`} aria-current={current ? "page" : undefined} {...openProps}>
    <span className="fm-sidebar-icon"><TrashGlyph /></span>
    <span className="fm-sidebar-name">Trash</span>
  </button></li>;
}

export function SidebarDrives({ rows, currentKey, ejecting, openProps, onEject, mountable, mounting, onMount }: {
  rows: readonly DriveRow[];
  /** The row holding the folder shown, if any. */
  currentKey: string | null;
  /** The drive being ejected, whose button waits. */
  ejecting: string | null;
  /** Opening a drive: its row's click, and ⌘-click (Ctrl-click) or a middle click for a new tab. */
  openProps: (row: DriveRow) => SidebarOpenProps;
  onEject: (row: DriveRow) => void;
  mountable: readonly MountableVolume[];
  mounting: string | null;
  onMount: (volume: MountableVolume) => void;
}) {
  return <>
    <div className="fm-sidebar-heading"><span id="fm-drives-heading">Drives</span></div>
    <ul className="fm-sidebar-list" aria-labelledby="fm-drives-heading">
      {rows.map((row) => {
        const current = currentKey === row.key;
        return <li key={row.key} className={`fm-drive${row.ejectable ? " is-ejectable" : ""}`}>
          <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}`} aria-current={current ? "page" : undefined} title={row.detail ? `${row.name}\n${row.detail}` : row.name} {...openProps(row)}>
            <span className="fm-sidebar-icon"><DriveGlyph removable={row.ejectable} /></span>
            <span className="fm-sidebar-name">{row.name}</span>
          </button>
          {row.ejectable ? <button type="button" className="fm-eject" aria-label={`Eject ${row.name}`} title={`Eject “${row.name}”`} disabled={ejecting === row.key} onClick={() => onEject(row)}><EjectGlyph /></button> : null}
        </li>;
      })}
      {mountable.map((volume) => <li key={volume.id} className="fm-drive">
        <button type="button" className="fm-sidebar-item" title={`Mount “${volume.name}”`} aria-label={`Mount ${volume.name}`} disabled={mounting !== null} onClick={() => onMount(volume)}>
          <span className="fm-sidebar-icon"><DriveGlyph removable /></span>
          <span className="fm-sidebar-name">{mounting === volume.id ? `Mounting ${volume.name}…` : volume.name}</span>
        </button>
      </li>)}
    </ul>
  </>;
}
