import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Add16Regular } from "@fluentui/react-icons";

import { combineActivityStatuses } from "../../lib/folder-nesting";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import type { ChatActivityStatus, ConnectedFolderSummary } from "../../types";
import { closedSidebarParents, sidebarConnectedFolderRows } from "./file-manager-model";
import { placeKey, type FileManagerLocation, type FileManagerPlace, type StandardFolderSummary } from "./file-manager-places";
import type { DriveRow, MountableVolume } from "./file-manager-drives";
import { SidebarDrives, SidebarTrashRow } from "./FileManagerSidebarPlaces";
import { StandardFolderGlyph } from "./file-manager-glyphs";
import { TintedFolder } from "./file-manager-folder";
import type { FolderLook } from "./FileEntries";

/** Connected Folders whose nested Connected Folders are shown in the sidebar. */
const sidebarOpenStorageKey = "amplefile.file-manager.sidebar-open.v1";

/** What a sidebar row opens in a new tab: a place's top, a drive's folder, the Trash, or Recents. */
export type SidebarTabTarget = FileManagerLocation | "recents" | "trash";

/** Dropping on a sidebar place: what the window's drops do there. */
export interface SidebarDropHandlers {
  /** The place a drag is over, by placeKey, or null. */
  over: string | null;
  dragOver: (target: FileManagerPlace, event: DragEvent<HTMLElement>) => void;
  dragLeave: () => void;
  drop: (target: FileManagerPlace, name: string, event: DragEvent<HTMLElement>) => void;
}

/**
 * The sidebar: Recents and Trash, the Standard Folders, the Connected Folders
 * (nested ones indented under their parent, behind a caret), and the drives,
 * with the update indicator at its foot.
 */
export function FileManagerSidebar({ connectedFolders, shownConnectedFolder, standardFolders, recentsOpen, trashOpen, atPlaceTop, isCurrent, folderStatuses, folderLook, drives, currentDrive, ejecting, mountable, mounting, onMountDrive, drop, onOpenRecents, onOpenTrash, onAddStandardFolder, onOpenPlace, onStandardFolderMenu, onAddConnectedFolderMenu, onConnectedFolderMenu, onOpenDrive, onEjectDrive, isNewTabClick, onOpenInNewTab, foot }: {
  connectedFolders: readonly ConnectedFolderSummary[];
  /** The Connected Folder shown, whose parents are kept open so where you are is in view. */
  shownConnectedFolder: ConnectedFolderSummary | null;
  standardFolders: readonly StandardFolderSummary[];
  recentsOpen: boolean;
  trashOpen: boolean;
  /** The folder shown is the top of its place. */
  atPlaceTop: boolean;
  isCurrent: (place: FileManagerPlace) => boolean;
  folderStatuses: Readonly<Record<string, ChatActivityStatus>>;
  folderLook: (connectedFolder: ConnectedFolderSummary) => FolderLook;
  drives: readonly DriveRow[];
  currentDrive: string | null;
  ejecting: string | null;
  mountable: readonly MountableVolume[];
  mounting: string | null;
  onMountDrive: (volume: MountableVolume) => void;
  drop: SidebarDropHandlers;
  onOpenRecents: () => void;
  onOpenTrash: () => void;
  onAddStandardFolder: () => void;
  onOpenPlace: (place: FileManagerPlace) => void;
  onStandardFolderMenu: (folder: StandardFolderSummary, event: MouseEvent<HTMLElement>) => void;
  onAddConnectedFolderMenu: (event: MouseEvent<HTMLElement>) => void;
  onConnectedFolderMenu: (connectedFolder: ConnectedFolderSummary, event: MouseEvent<HTMLElement>) => void;
  onOpenDrive: (row: DriveRow) => void;
  onEjectDrive: (row: DriveRow) => void;
  /** A click that opens a place in a new tab: ⌘-click on the Mac, Ctrl-click elsewhere. */
  isNewTabClick: (event: MouseEvent<HTMLElement>) => boolean;
  /** Opens a place, the Trash, or Recents in a new tab; a middle click leaves it behind. */
  onOpenInNewTab: (target: SidebarTabTarget, options: { behind: boolean }) => void;
  /** The update indicator, when there is one. */
  foot: ReactNode;
}) {
  // Nested Connected Folders sit under their parent in the sidebar behind a
  // caret; the parent of one is the deepest Connected Folder that contains it,
  // as everywhere else (src/shared/folder-nesting.ts).
  const [sidebarOpen, setSidebarOpenState] = useState<string[]>(() => readStoredJsonValue(sidebarOpenStorageKey, (value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [], []));
  const setSidebarOpen = (next: string[]) => { setSidebarOpenState(next); writeStoredJsonValue(sidebarOpenStorageKey, next); };
  const toggleSidebarFolder = (id: string) => setSidebarOpen(sidebarOpen.includes(id) ? sidebarOpen.filter((item) => item !== id) : [...sidebarOpen, id]);
  // Rows that just came into view (a parent opened, a Connected Folder was added)
  // grow in, one after another; rows that leave collapse through the shared
  // exit motion (lib/motion.ts). Arrival is decided while rendering so the
  // first frame already has it, and kept briefly so a re-render can't cut it.
  const sidebarRows = sidebarConnectedFolderRows(connectedFolders, sidebarOpen);
  const sidebarSeenRef = useRef<Set<string> | null>(null);
  const sidebarArrivalsRef = useRef(new Map<string, { until: number; index: number }>());
  {
    const now = Date.now();
    const arrivals = sidebarArrivalsRef.current;
    for (const [id, arrival] of arrivals) if (arrival.until < now) arrivals.delete(id);
    const seen = sidebarSeenRef.current;
    if (seen) {
      let index = 0;
      for (const row of sidebarRows) {
        if (!seen.has(row.connectedFolder.id) && !arrivals.has(row.connectedFolder.id)) arrivals.set(row.connectedFolder.id, { until: now + 700, index: index++ });
      }
    }
  }
  useEffect(() => { sidebarSeenRef.current = new Set(sidebarRows.map((row) => row.connectedFolder.id)); });
  // Going into a nested Connected Folder opens its parents, so where you are is always in view.
  useEffect(() => {
    if (!shownConnectedFolder) return;
    const closed = closedSidebarParents(shownConnectedFolder, connectedFolders, sidebarOpen);
    if (closed.length) setSidebarOpen([...sidebarOpen, ...closed]);
  }, [shownConnectedFolder?.id, connectedFolders]); // eslint-disable-line react-hooks/exhaustive-deps

  /** ⌘-click (Ctrl-click elsewhere) and a middle click open the row in a new tab; anything else is the row's own click. */
  const newTabProps = (target: SidebarTabTarget, open: () => void) => ({
    onClick: (event: MouseEvent<HTMLElement>) => { if (isNewTabClick(event)) onOpenInNewTab(target, { behind: false }); else open(); },
    onMouseDown: (event: MouseEvent<HTMLElement>) => { if (event.button === 1) event.preventDefault(); },
    onAuxClick: (event: MouseEvent<HTMLElement>) => { if (event.button === 1) { event.preventDefault(); onOpenInNewTab(target, { behind: true }); } },
  });

  return <nav className="fm-sidebar" aria-label="Sidebar">
    <div className="fm-sidebar-inset" aria-hidden="true" />
    <div className="fm-sidebar-scroll">
      <ul className="fm-sidebar-list fm-sidebar-top" aria-label="Recents">
        <li><button type="button" className={`fm-sidebar-item${recentsOpen ? " is-current" : ""}`} aria-current={recentsOpen ? "page" : undefined} {...newTabProps("recents", onOpenRecents)}>
          <span className="fm-sidebar-icon"><RecentsGlyph /></span>
          <span className="fm-sidebar-name">Recents</span>
        </button></li>
        <SidebarTrashRow current={trashOpen} openProps={newTabProps("trash", onOpenTrash)} />
      </ul>
      <div className="fm-sidebar-heading"><span id="fm-standard-heading">Standard Folders</span><button type="button" className="fm-heading-add" aria-label="Add a Folder to the Sidebar" title="Add a Folder" onClick={onAddStandardFolder}><Add16Regular /></button></div>
      {standardFolders.length ? <>
        <ul className="fm-sidebar-list" aria-labelledby="fm-standard-heading">
          {standardFolders.map((folder) => {
            const target: FileManagerPlace = { kind: "standard", id: folder.id };
            const current = isCurrent(target);
            return <li key={folder.id}>
              <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}${drop.over === placeKey(target) ? " is-drop-target" : ""}`} aria-current={current ? "page" : undefined} {...newTabProps({ place: target, path: "" }, () => onOpenPlace(target))} onContextMenu={(event) => onStandardFolderMenu(folder, event)}
                onDragOver={(event) => drop.dragOver(target, event)}
                onDragLeave={drop.dragLeave}
                onDrop={(event) => drop.drop(target, folder.name, event)}>
                <span className="fm-sidebar-icon"><StandardFolderGlyph id={folder.id} /></span>
                <span className="fm-sidebar-name">{folder.name}</span>
              </button>
            </li>;
          })}
        </ul>
      </> : null}
      <div className="fm-sidebar-heading"><span id="fm-connected-folders-heading">Connected Folders</span><button type="button" className="fm-heading-add" aria-label="Add a Connected Folder" title="Add a Connected Folder" aria-haspopup="menu" onClick={onAddConnectedFolderMenu}><Add16Regular /></button></div>
      <ul className="fm-sidebar-list" aria-labelledby="fm-connected-folders-heading">
        {sidebarRows.map(({ connectedFolder: item, depth, inside, open }) => {
          const look = folderLook(item);
          const target: FileManagerPlace = { kind: "connected-folder", id: item.id };
          const current = isCurrent(target);
          // A closed parent shows its nested Connected Folders' activity on its own row.
          const status = inside.length && !open ? combineActivityStatuses([folderStatuses[item.id], ...inside.map((child) => folderStatuses[child.id])]) ?? undefined : folderStatuses[item.id];
          const arrival = sidebarArrivalsRef.current.get(item.id);
          return <li key={item.id} className={`fm-sidebar-node${arrival ? " is-arriving" : ""}`} data-exit-motion={depth > 0 ? "collapse" : undefined} style={{ "--fm-depth": depth, ...(arrival ? { "--fm-arrive-index": arrival.index } : {}) } as CSSProperties}>
            {inside.length ? <button type="button" className={`fm-sidebar-caret${open ? " is-open" : ""}`} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} Connected Folders inside ${item.name}`} title={open ? "Hide Connected Folders inside" : "Show Connected Folders inside"} onClick={() => toggleSidebarFolder(item.id)}>
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3.5 3-3.5 3z" fill="currentColor" /></svg>
            </button> : null}
            <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}${drop.over === placeKey(target) ? " is-drop-target" : ""}`} aria-current={current ? "page" : undefined} {...newTabProps({ place: target, path: "" }, () => {
                // A parent opens on the first click and goes to its top; clicking
                // it again while there closes it.
                const atTop = current && atPlaceTop;
                if (inside.length && atTop && open) { toggleSidebarFolder(item.id); return; }
                if (inside.length && !open) toggleSidebarFolder(item.id);
                if (!atTop) onOpenPlace(target);
              })} onContextMenu={(event) => onConnectedFolderMenu(item, event)}
              onKeyDown={(event) => {
                if (!inside.length) return;
                if (event.key === "ArrowRight" && !open) { event.preventDefault(); toggleSidebarFolder(item.id); }
                if (event.key === "ArrowLeft" && open) { event.preventDefault(); toggleSidebarFolder(item.id); }
              }}
              onDragOver={(event) => drop.dragOver(target, event)}
              onDragLeave={drop.dragLeave}
              onDrop={(event) => drop.drop(target, item.name, event)}>
              <span className="fm-sidebar-icon"><TintedFolder color={look.color} symbol={look.symbol} /></span>
              <span className="fm-sidebar-name">{item.name}</span>
              <ActivityDot status={status} />
            </button>
          </li>;
        })}
      </ul>
      <SidebarDrives rows={drives} currentKey={currentDrive} ejecting={ejecting} onEject={onEjectDrive} mountable={mountable} mounting={mounting} onMount={onMountDrive} openProps={(row) => newTabProps(row.location, () => onOpenDrive(row))} />
    </div>
    {foot}
  </nav>;
}

/** Recents' clock, drawn as the sidebar's other line glyphs are. */
export function RecentsGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.5 1.5" /></svg>;
}

/** The design's activity dot: pulsing while a Worker runs, green for a reply nobody has read. */
function ActivityDot({ status }: { status?: "running" | "attention" }) {
  if (!status) return null;
  return <span className={`fm-dot ${status === "running" ? "is-run" : "is-done"}`} aria-label={status === "running" ? "Working" : "New reply"} role="img" />;
}
