import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Add16Regular, Dismiss12Regular } from "@fluentui/react-icons";

import "./file-manager-tabs.css";
import { cssEscape } from "./file-manager-view-helpers";

/** One tab as the strip draws it. */
export interface FolderTabItem {
  id: string;
  title: string;
  /** Where the tab is, in full, for its tooltip. */
  detail: string;
  /** Files can be dropped into the tab's folder (not its Trash or Recents). */
  takesDrop: boolean;
}

/** What the window puts on a tab dragged inside the strip. */
const folderTabDragType = "application/x-amplefile-folder-tab";
/** How long a drag of items rests over a tab before that tab comes to the front, as Finder's spring-loaded tabs do. */
export const tabSpringDelayMs = 600;

/**
 * The folder tab strip at the top of the folder area (docs/product-model.md,
 * "Folder tabs"). Tabs share its width; a click shows a tab, its × or a
 * middle click closes it, + opens a new one, and dragging a tab moves it. A
 * drag of items that rests on a tab brings it to the front, and dropping
 * them on a tab moves or copies them into that tab's folder.
 */
export function FolderTabStrip({ tabs, activeId, onSelect, onClose, onNew, onMove, isItemDrag, onItemDragOver, onItemDrop }: {
  tabs: readonly FolderTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** `toIndex` is where the tab lands among the tabs as they are after it is taken out. */
  onMove: (id: string, toIndex: number) => void;
  isItemDrag: (event: DragEvent<HTMLElement>) => boolean;
  /** A drag of items over a tab: the effect it would have there ("copy", "move", or "none"). */
  onItemDragOver: (id: string, event: DragEvent<HTMLElement>) => void;
  onItemDrop: (id: string, event: DragEvent<HTMLElement>) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [itemOver, setItemOver] = useState<string | null>(null);
  const springRef = useRef<{ id: string; timer: number } | null>(null);
  const canClose = tabs.length > 1;

  function cancelSpring() {
    if (springRef.current) window.clearTimeout(springRef.current.timer);
    springRef.current = null;
  }
  useEffect(() => cancelSpring, []);

  function tabDragStart(id: string, event: DragEvent<HTMLElement>) {
    draggingRef.current = id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(folderTabDragType, id);
  }

  function tabDragEnd() {
    draggingRef.current = null;
    setDropMark(null);
  }

  function dragOver(id: string, event: DragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes(folderTabDragType)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect();
      const side = event.clientX < box.left + box.width / 2 ? "before" : "after";
      setDropMark((current) => current?.id === id && current.side === side ? current : { id, side });
      return;
    }
    if (!isItemDrag(event)) return;
    setItemOver((current) => current === id ? current : id);
    // Resting on another tab brings it to the front, so the drop can go into a folder inside it.
    if (id !== activeId && springRef.current?.id !== id) {
      cancelSpring();
      springRef.current = { id, timer: window.setTimeout(() => { springRef.current = null; onSelect(id); }, tabSpringDelayMs) };
    }
    onItemDragOver(id, event);
  }

  function dragLeave(id: string, event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropMark((current) => current?.id === id ? null : current);
    setItemOver((current) => current === id ? null : current);
    if (springRef.current?.id === id) cancelSpring();
  }

  function drop(id: string, event: DragEvent<HTMLElement>) {
    cancelSpring();
    setItemOver(null);
    const moved = event.dataTransfer.types.includes(folderTabDragType) ? event.dataTransfer.getData(folderTabDragType) || draggingRef.current : null;
    if (moved) {
      event.preventDefault();
      const mark = dropMark;
      setDropMark(null);
      const from = tabs.findIndex((tab) => tab.id === moved);
      const over = tabs.findIndex((tab) => tab.id === id);
      if (from < 0 || over < 0 || moved === id) return;
      const after = mark?.id === id ? mark.side === "after" : false;
      // Positions among the tabs once the moved one is taken out.
      const toIndex = (from < over ? over - 1 : over) + (after ? 1 : 0);
      onMove(moved, toIndex);
      return;
    }
    if (!isItemDrag(event)) return;
    onItemDrop(id, event);
  }

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? tabs[0] : tabs.at(-1);
      if (next) choose(next.id, true);
      return;
    }
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) choose(next.id, true);
  }

  function choose(id: string, focus = false) {
    onSelect(id);
    if (focus) window.requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-folder-tab="${cssEscape(id)}"] [role="tab"]`)?.focus());
  }

  function auxClick(id: string, event: MouseEvent<HTMLElement>) {
    if (event.button !== 1 || !canClose) return;
    event.preventDefault();
    onClose(id);
  }

  return <div className="fm-folder-tabs" ref={stripRef}>
    <div className="fm-folder-tabs-list" role="tablist" aria-label="Folder Tabs">
      {tabs.map((tab, index) => {
        const on = tab.id === activeId;
        const mark = dropMark?.id === tab.id ? dropMark.side : null;
        return <div
          key={tab.id}
          data-folder-tab={tab.id}
          className={`fm-folder-tab${on ? " is-on" : ""}${mark ? ` is-drop-${mark}` : ""}${itemOver === tab.id && tab.takesDrop ? " is-drop-target" : ""}`}
          draggable
          onDragStart={(event) => tabDragStart(tab.id, event)}
          onDragEnd={tabDragEnd}
          onDragOver={(event) => dragOver(tab.id, event)}
          onDragLeave={(event) => dragLeave(tab.id, event)}
          onDrop={(event) => drop(tab.id, event)}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => auxClick(tab.id, event)}
          title={tab.detail}
        >
          {canClose ? <button type="button" className="fm-folder-tab-close" aria-label={`Close ${tab.title}`} title="Close Tab" tabIndex={-1} onClick={() => onClose(tab.id)}><Dismiss12Regular /></button> : null}
          <button
            type="button"
            role="tab"
            className="fm-folder-tab-main"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => choose(tab.id)}
            onKeyDown={(event) => tabKeyDown(event, index)}
          ><span className="fm-folder-tab-title">{tab.title}</span></button>
        </div>;
      })}
    </div>
    <button type="button" className="fm-folder-tabs-new" aria-label="New Tab" title="New Tab" onClick={onNew}><Add16Regular /></button>
  </div>;
}
