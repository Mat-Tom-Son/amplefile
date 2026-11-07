import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { applicationPalettes, type ApplicationAppearance } from "../../../src/shared/application-appearance";
import type { ResolverGround, ConnectedFolderAppearanceMode } from "../../../src/shared/connected-folder-appearance";
import { connectedFolderIdentityFor } from "./connected-folder-identity";
import type { ConnectedFolderCustomizationMap, ConnectedFolderSummary } from "../types";

type Grounds = Record<ConnectedFolderAppearanceMode, ResolverGround>;
const ConnectedFolderAppearanceGrounds = createContext<Grounds | undefined>(undefined);

export function applicationConnectedFolderGrounds(palette: ApplicationAppearance["palette"]): Grounds {
  const chosen = applicationPalettes[palette];
  return {
    light: { mode: "light", surface: chosen.light.surface, canvas: chosen.light.canvas, softAlpha: 0.13 },
    dark: { mode: "dark", surface: chosen.dark.surface, canvas: chosen.dark.canvas, softAlpha: 0.13 },
  };
}

export function ConnectedFolderAppearanceProvider({ palette, children }: { palette: ApplicationAppearance["palette"]; children: ReactNode }) {
  const grounds = useMemo(() => applicationConnectedFolderGrounds(palette), [palette]);
  return <ConnectedFolderAppearanceGrounds.Provider value={grounds}>{children}</ConnectedFolderAppearanceGrounds.Provider>;
}

/** Resolve the same saved identity against this renderer's current surfaces. */
export function useConnectedFolderIdentityResolver() {
  const grounds = useContext(ConnectedFolderAppearanceGrounds);
  return useCallback((connectedFolder: ConnectedFolderSummary, customizations: ConnectedFolderCustomizationMap) => connectedFolderIdentityFor(connectedFolder, customizations, grounds), [grounds]);
}
