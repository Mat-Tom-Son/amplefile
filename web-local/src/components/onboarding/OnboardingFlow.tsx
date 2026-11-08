import { useEffect, useState } from "react";

import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api } from "../../lib/api";
import { includedToolsPath } from "../../lib/included-tool-scope";

/**
 * Whether first run offers Computer Control: on a Mac that supports it, while
 * it is not ready yet. Never outside the desktop app, where it is not included.
 */
export function useComputerControlOffer(fixtureMode: boolean): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (fixtureMode) return;
    const controller = new AbortController();
    api<{ tools: IncludedToolStatus[] }>(includedToolsPath(), { signal: controller.signal })
      .then(({ tools: statuses }) => {
        const computer = statuses.find((item) => item.id === "computer");
        if (!controller.signal.aborted) setOffered(Boolean(computer && computer.state !== "ready" && computer.facts?.supportedOS !== false));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [fixtureMode]);
  return offered;
}
