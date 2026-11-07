import {
  normalizeConnectedFolderAppearanceBannerImage,
  normalizeConnectedFolderAppearanceCustomizations,
} from "../../../src/shared/connected-folder-appearance";
import { defaultConnectedFolderBannerName, connectedFolderBannerOptions } from "../constants";
import type { ConnectedFolderBannerImagePosition, ConnectedFolderBannerOption, ConnectedFolderCustomizationMap } from "../types";

export function connectedFolderBannerOptionFor(bannerName: string | null | undefined): ConnectedFolderBannerOption {
  const normalized = bannerName?.trim().toLowerCase();
  return connectedFolderBannerOptions.find((option) => option.name === normalized)
    ?? connectedFolderBannerOptions.find((option) => option.name === defaultConnectedFolderBannerName)
    ?? connectedFolderBannerOptions[0];
}

export function normalizeConnectedFolderBannerImage(value: string | null | undefined): string | null {
  return normalizeConnectedFolderAppearanceBannerImage(value);
}

export function normalizeConnectedFolderBannerImagePosition(value: unknown): ConnectedFolderBannerImagePosition {
  return value === "top" || value === "bottom" ? value : "center";
}

export function normalizeConnectedFolderCustomizations(
  value: unknown,
  allowedConnectedFolderIds?: ReadonlySet<string>,
  allowedIconNames?: ReadonlySet<string>,
): ConnectedFolderCustomizationMap {
  return normalizeConnectedFolderAppearanceCustomizations(value, {
    allowedConnectedFolderIds,
    allowedIconNames,
    allowedBannerNames: new Set(connectedFolderBannerOptions.map((option) => option.name)),
  });
}
