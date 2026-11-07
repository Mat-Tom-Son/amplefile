import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  connectedFolderChatPreferredMinWidth,
  connectedFolderPaneKeyboardLargeStep,
  connectedFolderPaneKeyboardStep,
  connectedFolderPaneResizeHandleWidth,
  connectedFolderSidebarPreferredMaxWidth,
  connectedFolderSidebarPreferredMinWidth,
  connectedFolderSidebarWidthPreferenceKey,
} from "../constants";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import type { ConnectedFolderPaneBounds } from "../types";

function readStoredConnectedFolderSidebarWidth(): number | null {
  const stored = readStoredValue(connectedFolderSidebarWidthPreferenceKey);
  if (!stored) return null;
  const width = Number.parseInt(stored, 10);
  return Number.isFinite(width) ? width : null;
}

function writeStoredConnectedFolderSidebarWidth(width: number | null) {
  writeStoredValue(connectedFolderSidebarWidthPreferenceKey, width === null ? null : String(Math.round(width)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePaneResize(deterministic = false) {
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => deterministic ? null : readStoredConnectedFolderSidebarWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const connectedFolderLayoutRef = useRef<HTMLElement | null>(null);
  const preferredSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const renderedSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  // Pane bounds are stable for the duration of a pointer drag; cache them so
  // per-frame renders skip getComputedStyle.
  const dragBoundsRef = useRef<ConnectedFolderPaneBounds | null>(null);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.();
    sidebarResizeCleanupRef.current = null;
    if (sidebarResizeFrameRef.current !== null) window.cancelAnimationFrame(sidebarResizeFrameRef.current);
    document.body.classList.remove("connected-folder-pane-resizing");
  }, []);

  useEffect(() => {
    const layout = connectedFolderLayoutRef.current;
    if (!layout) return;
    const initialWidth = preferredSidebarWidthRef.current ?? defaultConnectedFolderSidebarWidth(layout);
    renderConnectedFolderSidebarWidth(initialWidth);
  }, []);

  useEffect(() => {
    const layout = connectedFolderLayoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      renderConnectedFolderSidebarWidth(preferredSidebarWidthRef.current ?? defaultConnectedFolderSidebarWidth(layout));
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  function connectedFolderPaneBounds(layout = connectedFolderLayoutRef.current): ConnectedFolderPaneBounds {
    if (!layout) {
      return {
        min: connectedFolderSidebarPreferredMinWidth,
        max: connectedFolderSidebarPreferredMaxWidth,
        fallback: 420,
      };
    }
    const styles = window.getComputedStyle(layout);
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    const availableWidth = Math.max(0, layout.clientWidth - horizontalPadding);
    const minimumByChat = Math.max(220, availableWidth - connectedFolderPaneResizeHandleWidth - connectedFolderChatPreferredMinWidth);
    const min = Math.min(connectedFolderSidebarPreferredMinWidth, minimumByChat);
    const max = Math.max(min, Math.min(connectedFolderSidebarPreferredMaxWidth, availableWidth - connectedFolderPaneResizeHandleWidth - connectedFolderChatPreferredMinWidth));
    const fallback = clampNumber(Math.round(availableWidth * 0.34), min, max);
    return { min, max, fallback };
  }

  function defaultConnectedFolderSidebarWidth(layout = connectedFolderLayoutRef.current): number {
    return connectedFolderPaneBounds(layout).fallback;
  }

  function renderConnectedFolderSidebarWidth(width: number): number {
    const bounds = dragBoundsRef.current ?? connectedFolderPaneBounds();
    const nextWidth = Math.round(clampNumber(width, bounds.min, bounds.max));
    renderedSidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    connectedFolderLayoutRef.current?.style.setProperty("--connected-folder-sidebar-width", `${nextWidth}px`);
    return nextWidth;
  }

  function queueConnectedFolderSidebarWidth(width: number) {
    pendingSidebarWidthRef.current = width;
    if (sidebarResizeFrameRef.current !== null) return;
    sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
      sidebarResizeFrameRef.current = null;
      const pendingWidth = pendingSidebarWidthRef.current;
      if (pendingWidth !== null) renderConnectedFolderSidebarWidth(pendingWidth);
    });
  }

  function commitConnectedFolderSidebarWidth(width: number | null = renderedSidebarWidthRef.current) {
    if (width === null) return;
    const nextWidth = renderConnectedFolderSidebarWidth(width);
    preferredSidebarWidthRef.current = nextWidth;
    if (!deterministic) writeStoredConnectedFolderSidebarWidth(nextWidth);
  }

  function resetConnectedFolderSidebarWidth() {
    preferredSidebarWidthRef.current = null;
    if (!deterministic) writeStoredConnectedFolderSidebarWidth(null);
    renderConnectedFolderSidebarWidth(defaultConnectedFolderSidebarWidth());
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const layout = connectedFolderLayoutRef.current;
    if (!layout) return;
    event.preventDefault();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      resizeHandle.setPointerCapture(pointerId);
    } catch {
      // Pointer capture can fail for synthetic or already-cancelled events; window listeners still cover normal drags.
    }
    setSidebarResizing(true);
    document.body.classList.add("connected-folder-pane-resizing");
    const pane = document.getElementById("connected-folder-file-panel");
    const dragStartClientX = event.clientX;
    dragBoundsRef.current = connectedFolderPaneBounds(layout);
    const dragStartWidth = pane?.getBoundingClientRect().width ?? renderedSidebarWidthRef.current ?? defaultConnectedFolderSidebarWidth(layout);
    const widthFromPointer = (clientX: number) => dragStartWidth + clientX - dragStartClientX;
    let stopped = false;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      queueConnectedFolderSidebarWidth(widthFromPointer(pointerEvent.clientX));
    };
    const stopResize = (pointerEvent?: PointerEvent | Event) => {
      if (stopped) return;
      stopped = true;
      dragBoundsRef.current = null;
      if (pointerEvent) pointerEvent.preventDefault();
      sidebarResizeCleanupRef.current?.();
      sidebarResizeCleanupRef.current = null;
      try {
        if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      } catch {
        // The pointer may already be released by the browser.
      }
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      if (pendingSidebarWidthRef.current !== null) renderConnectedFolderSidebarWidth(pendingSidebarWidthRef.current);
      pendingSidebarWidthRef.current = null;
      commitConnectedFolderSidebarWidth();
      setSidebarResizing(false);
      document.body.classList.remove("connected-folder-pane-resizing");
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopResize, { passive: false });
    window.addEventListener("pointercancel", stopResize, { passive: false });
    window.addEventListener("blur", stopResize);
    resizeHandle.addEventListener("lostpointercapture", stopResize);
    sidebarResizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
      resizeHandle.removeEventListener("lostpointercapture", stopResize);
    };
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const bounds = connectedFolderPaneBounds();
    const currentWidth = renderedSidebarWidthRef.current ?? bounds.fallback;
    const step = event.shiftKey ? connectedFolderPaneKeyboardLargeStep : connectedFolderPaneKeyboardStep;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = currentWidth - step;
    else if (event.key === "ArrowRight") nextWidth = currentWidth + step;
    else if (event.key === "Home") nextWidth = bounds.min;
    else if (event.key === "End") nextWidth = bounds.max;
    else if (event.key === "Enter") {
      event.preventDefault();
      resetConnectedFolderSidebarWidth();
      return;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    commitConnectedFolderSidebarWidth(nextWidth);
  }

  const sidebarResizeBounds = connectedFolderPaneBounds();
  const sidebarResizeValue = Math.round(clampNumber(sidebarWidth ?? sidebarResizeBounds.fallback, sidebarResizeBounds.min, sidebarResizeBounds.max));

  return {
    sidebarWidth,
    sidebarResizing,
    connectedFolderLayoutRef,
    resetConnectedFolderSidebarWidth,
    startSidebarResize,
    handleSidebarResizeKeyDown,
    sidebarResizeBounds,
    sidebarResizeValue,
  };
}
