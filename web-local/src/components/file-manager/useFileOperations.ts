import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, createEventSource, errorText } from "../../lib/api";
import {
  applyOperationEvent,
  nextOperationReveal,
  visibleOperations,
  type FileOperationEvent,
  type FileOperationKind,
  type WindowOperation,
} from "./file-operations-model";

/** Thrown into an operation's run when Stop came before its request was sent (it was waiting its turn). */
export class OperationStoppedBeforeStart extends Error {
  constructor() { super("Stopped before it started."); }
}

export interface OperationHandle {
  /** The id the request carries (`operationId`), for progress and Stop. */
  operationId: string;
  /** Call right before sending: throws when Stop came while the operation waited its turn. */
  beforeSend: () => void;
}

/**
 * The window's running file operations (copy, move, Duplicate, paste,
 * Compress, Extract): each carries an `operationId`, the engine's progress
 * events (`/api/file-transfer/events`, on the window's one event connection)
 * move its bar, and Stop asks the engine to stop at its next safe point. The
 * window stays usable meanwhile, and several run at once. A quick one never
 * shows (file-operations-model.ts, `operationShowAfterMs`).
 */
export function useFileOperations(enabled: boolean) {
  const [operations, setOperations] = useState<readonly WindowOperation[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const stoppedEarlyRef = useRef(new Set<string>());
  const sentRef = useRef(new Set<string>());
  const running = operations.length > 0;

  // Listen only while something runs: the first event lists what is running, so nothing is missed.
  useEffect(() => {
    if (!enabled || !running) return;
    const source = createEventSource("/api/file-transfer/events");
    source.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data) as FileOperationEvent;
        setOperations((current) => applyOperationEvent(current, event));
      } catch {
        // A frame this window does not understand moves nothing.
      }
    };
    return () => source.close();
  }, [enabled, running]);

  // Re-render when a waiting operation is old enough to show.
  useEffect(() => {
    const wait = nextOperationReveal(operations, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 10);
    return () => window.clearTimeout(timer);
  }, [operations, now]);

  const run = useCallback(async <T,>(kind: FileOperationKind, title: string, work: (handle: OperationHandle) => Promise<T>): Promise<T> => {
    const id = newOperationId();
    setOperations((current) => [...current, { id, kind, title, startedAt: Date.now(), progress: null, stopping: false }]);
    try {
      return await work({
        operationId: id,
        beforeSend: () => {
          if (stoppedEarlyRef.current.has(id)) throw new OperationStoppedBeforeStart();
          sentRef.current.add(id);
        },
      });
    } finally {
      stoppedEarlyRef.current.delete(id);
      sentRef.current.delete(id);
      setOperations((current) => current.filter((operation) => operation.id !== id));
    }
  }, []);

  const stop = useCallback(async (id: string): Promise<string | null> => {
    setOperations((current) => current.map((operation) => operation.id === id ? { ...operation, stopping: true } : operation));
    // A request just sent may not have reached the engine yet: ask again briefly.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await api("/api/file-transfer/cancel", { method: "POST", body: { operationId: id } });
        return null;
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 404)) {
          setOperations((current) => current.map((operation) => operation.id === id ? { ...operation, stopping: false } : operation));
          return errorText(caught);
        }
        // Still waiting its turn behind another change: it will not start.
        if (!sentRef.current.has(id)) { stoppedEarlyRef.current.add(id); return null; }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    return null;
  }, []);

  return { operations, shown: visibleOperations(operations, now), run, stop };
}

function newOperationId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `fm-${random}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}
