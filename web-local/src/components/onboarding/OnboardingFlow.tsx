import { useEffect, useState } from "react";

import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api } from "../../lib/api";
import { includedToolsPath } from "../../lib/included-tool-scope";
export type MacTool = "chrome" | "computer";

/**
 * The included Mac tools first run can offer: Chrome when its extension is
 * available, and Computer Control on a Mac that supports it. None outside the
 * desktop app, where the tools are not included.
 */
export function useMacTools(fixtureMode: boolean): MacTool[] {
  const [tools, setTools] = useState<MacTool[]>([]);
  useEffect(() => {
    if (fixtureMode) return;
    const controller = new AbortController();
    api<{ tools: IncludedToolStatus[] }>(includedToolsPath(), { signal: controller.signal })
      .then(({ tools: statuses }) => {
        const offered: MacTool[] = [];
        const chrome = statuses.find((item) => item.id === "chrome");
        if (chrome && chrome.chrome?.state !== "store_unavailable" && chrome.chrome?.state !== "connected") offered.push("chrome");
        const computer = statuses.find((item) => item.id === "computer");
        if (computer && computer.state !== "ready" && computer.facts?.supportedOS !== false) offered.push("computer");
        if (!controller.signal.aborted) setTools(offered);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [fixtureMode]);
  return tools;
}
