import type { CSSProperties } from "react";
import {
  defaultConnectedFolderAccent,
  primaryAccentIdentity,
  normalizeConnectedFolderAppearanceBannerFraming,
  resolveConnectedFolderAppearance,
  secondaryAccentIdentity,
  type ResolvedConnectedFolderAppearance,
  type ConnectedFolderAppearanceMode,
  type ResolverGround,
  type ConnectedFolderAppearanceBannerFraming,
  type ConnectedFolderAppearanceBannerLayout,
  type ConnectedFolderAppearanceBannerIconStyle,
  type ConnectedFolderAppearanceBannerTitleFill,
  type ConnectedFolderAppearanceBannerPresetId,
} from "../../../src/shared/connected-folder-appearance";
import { maxConnectedFolderBannerImageDataUrlLength, maxConnectedFolderBannerImageFileBytes } from "../constants";
import { connectedFolderIconOptionFor, type ConnectedFolderIconOption } from "../connected-folder-icons";
import type { ConnectedFolderBannerImagePosition, ConnectedFolderColorOption, ConnectedFolderCustomizationMap, ConnectedFolderSummary } from "../types";
import { readableTextColorOn } from "./color-contrast";
import { normalizeConnectedFolderBannerImage, normalizeConnectedFolderBannerImagePosition, connectedFolderBannerOptionFor } from "./connected-folder-customization";
import { connectedFolderBannerPresetFor } from "./connected-folder-banner-presets";

// Picker colors can evolve without recoloring Connected Folders that use their original default.
export const connectedFolderColorOptions: ConnectedFolderColorOption[] = [
  connectedFolderColor("Slate", "#64748b"),
  connectedFolderColor("Stone", "#a8a29e"),
  connectedFolderColor("Sand", "#d6a46b"),
  connectedFolderColor("Cocoa", "#a47551"),
  connectedFolderColor("Rose", "#f43f5e"),
  connectedFolderColor("Coral", "#fb7185"),
  connectedFolderColor("Orange", "#f97316"),
  connectedFolderColor("Amber", "#f59e0b"),
  connectedFolderColor("Yellow", "#eab308"),
  connectedFolderColor("Lime", "#84cc16"),
  connectedFolderColor("Sage", "#84a98c"),
  connectedFolderColor("Green", "#22c55e"),
  connectedFolderColor("Forest", "#15803d"),
  connectedFolderColor("Mint", "#6ee7b7"),
  connectedFolderColor("Teal", "#14b8a6"),
  connectedFolderColor("Cyan", "#06b6d4"),
  connectedFolderColor("Sky", "#38bdf8"),
  connectedFolderColor("Blue", "#3b82f6"),
  connectedFolderColor("Indigo", "#6366f1"),
  connectedFolderColor("Violet", "#8b5cf6"),
  connectedFolderColor("Lavender", "#c4b5fd"),
  connectedFolderColor("Plum", "#a855f7"),
  connectedFolderColor("Pink", "#f472b6"),
  connectedFolderColor("Fuchsia", "#d946ef"),
];

export function defaultConnectedFolderColor(connectedFolderId: string): ConnectedFolderColorOption {
  const { label, hex } = defaultConnectedFolderAccent(connectedFolderId);
  return connectedFolderColor(label, hex);
}

export function connectedFolderColor(label: string, color: string): ConnectedFolderColorOption {
  const normalizedColor = normalizeConnectedFolderColor(color);
  return {
    label,
    color: normalizedColor,
    soft: hexColorToRgba(normalizedColor, 0.13),
    border: hexColorToRgba(normalizedColor, 0.5),
  };
}

export function normalizeConnectedFolderColor(color: string, fallback = "#60646c"): string {
  const normalized = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
}

export function hexColorToRgba(color: string, alpha: number): string {
  return `rgba(${hexColorToRgbTriple(color)}, ${alpha})`;
}

export function hexColorToRgbTriple(color: string): string {
  const normalized = color.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

export function blendHexColors(first: string, second: string): string {
  if (first === second) return first;
  const channel = (color: string, offset: number) => Number.parseInt(color.replace("#", "").slice(offset, offset + 2), 16);
  const mixed = [0, 2, 4].map((offset) => Math.round((channel(first, offset) + channel(second, offset)) / 2));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

interface ConnectedFolderIdentity {
  color: string;
  softColor: string;
  borderColor: string;
  accentRgb: string;
  secondaryColor: string;
  secondaryRgb: string;
  hasCustomSecondary: boolean;
  onAccentColor: string;
  onPrimaryAccentColor: string;
  resolved: ResolvedConnectedFolderAppearance;
  bannerName: string;
  bannerImage: string | null;
  bannerImagePosition: ConnectedFolderBannerImagePosition;
  bannerPreset: ConnectedFolderAppearanceBannerPresetId | null;
  bannerFraming: ConnectedFolderAppearanceBannerFraming;
  bannerLayout: ConnectedFolderAppearanceBannerLayout;
  /** Effective choices: Card has no icon and images get a frosted name unless chosen otherwise. */
  bannerIconStyle: ConnectedFolderAppearanceBannerIconStyle;
  bannerTitleFill: ConnectedFolderAppearanceBannerTitleFill;
  iconName: string;
  iconLabel: string;
  Icon: ConnectedFolderIconOption["Icon"];
}

function connectedFolderIdentityFor(connectedFolder: ConnectedFolderSummary, customizations: ConnectedFolderCustomizationMap, grounds?: Record<ConnectedFolderAppearanceMode, ResolverGround>): ConnectedFolderIdentity {
  const defaultColor = defaultConnectedFolderColor(connectedFolder.id);
  const custom = customizations[connectedFolder.id] ?? {};
  const primaryIdentity = primaryAccentIdentity(custom, defaultColor.color);
  const secondaryIdentity = secondaryAccentIdentity(custom, primaryIdentity);
  const colorOption = connectedFolderColor("Custom", primaryIdentity.referenceHex);
  const hasCustomSecondary = Boolean(custom.secondary || custom.color2);
  const secondaryColor = secondaryIdentity.referenceHex;
  const iconOption = connectedFolderIconOptionFor(custom.iconName ?? defaultConnectedFolderIconName(connectedFolder));
  const customBannerImage = normalizeConnectedFolderBannerImage(custom.bannerImage);
  const preset = !customBannerImage ? connectedFolderBannerPresetFor(custom.bannerPreset) : undefined;
  const bannerImage = customBannerImage ?? preset?.image ?? null;
  const bannerName = connectedFolderBannerOptionFor(custom.bannerName).name;
  const resolved = resolveConnectedFolderAppearance({
    primary: primaryIdentity,
    secondary: secondaryIdentity,
    bannerName,
    hasBannerImage: Boolean(bannerImage),
    grounds,
  });
  return {
    color: colorOption.color,
    softColor: colorOption.soft,
    borderColor: colorOption.border,
    accentRgb: hexColorToRgbTriple(colorOption.color),
    secondaryColor,
    secondaryRgb: hexColorToRgbTriple(secondaryColor),
    hasCustomSecondary,
    onAccentColor: readableTextColorOn(blendHexColors(colorOption.color, secondaryColor)),
    onPrimaryAccentColor: readableTextColorOn(colorOption.color),
    resolved,
    bannerName,
    bannerImage,
    bannerImagePosition: normalizeConnectedFolderBannerImagePosition(custom.bannerImagePosition),
    bannerPreset: preset?.id ?? null,
    bannerFraming: normalizeConnectedFolderAppearanceBannerFraming(custom.bannerFraming) ?? {
      x: 50, y: custom.bannerImagePosition === "top" ? 0 : custom.bannerImagePosition === "bottom" ? 100 : 50, zoom: 1,
    },
    bannerLayout: custom.bannerLayout ?? "card",
    bannerIconStyle: custom.bannerIconStyle ?? ((custom.bannerLayout ?? "card") === "card" ? "none" : "square"),
    bannerTitleFill: custom.bannerTitleFill ?? (bannerImage && custom.bannerLayout !== "band" ? "frosted" : "none"),
    iconName: iconOption.name,
    iconLabel: iconOption.label,
    Icon: iconOption.Icon,
  };
}

function connectedFolderIdentityStyle(identity: ConnectedFolderIdentity, mode?: ConnectedFolderAppearanceMode): CSSProperties {
  const role = <K extends keyof ResolvedConnectedFolderAppearance["light"]>(name: K): ResolvedConnectedFolderAppearance["light"][K] => (
    mode ? identity.resolved[mode][name] : `light-dark(${identity.resolved.light[name]}, ${identity.resolved.dark[name]})`
  ) as ResolvedConnectedFolderAppearance["light"][K];
  return {
    ...(identity.bannerPreset ? {
      "--connected-folder-image-title": identity.bannerPreset === "dusk" ? "#ffffff" : mode === "light" ? "#152a2c" : mode === "dark" ? "#ffffff" : "light-dark(#152a2c, #ffffff)",
      "--connected-folder-image-scrim": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.24)" : mode === "light" ? "rgba(255, 255, 255, 0.18)" : mode === "dark" ? "rgba(9, 14, 24, 0.58)" : "light-dark(rgba(255, 255, 255, 0.18), rgba(9, 14, 24, 0.58))",
      "--connected-folder-image-button": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.56)" : mode === "light" ? "rgba(255, 255, 255, 0.84)" : mode === "dark" ? "rgba(9, 14, 24, 0.56)" : "light-dark(rgba(255, 255, 255, 0.84), rgba(9, 14, 24, 0.56))",
    } : {}),
    "--connected-folder-accent-text-body": role("textBody"),
    "--connected-folder-accent-text-ui": role("textUi"),
    "--connected-folder-accent-glyph": role("glyph"),
    "--connected-folder-accent-solid": role("solid"),
    "--connected-folder-on-accent-solid": role("onSolid"),
    "--connected-folder-on-accent-muted": role("onSolidMuted"),
    "--connected-folder-accent-soft-fill": role("softFill"),
    "--connected-folder-accent-border-state": role("borderState"),
    "--connected-folder-accent-border-decor": role("borderDecor"),
    "--connected-folder-accent-focus-ring": role("focusRing"),
    "--connected-folder-accent-indicator": role("indicator"),
    "--connected-folder-banner-secondary": identity.resolved.light.bannerSecondary,
    "--connected-folder-banner-primary-rgb": identity.accentRgb,
    "--connected-folder-banner-secondary-rgb": identity.secondaryRgb,
    "--surface-tab-accent": identity.color,
    "--surface-tab-accent-soft": identity.softColor,
    // Transitional aliases retain their v1 rendering semantics until every
    // remaining call site has been assigned a semantic role.
    "--connected-folder-custom-color": identity.color,
    "--connected-folder-custom-color-soft": identity.softColor,
    "--connected-folder-selection-accent": identity.color,
    "--connected-folder-selection-accent-rgb": identity.accentRgb,
    "--connected-folder-selection-accent2": identity.secondaryColor,
    "--connected-folder-selection-accent2-rgb": identity.secondaryRgb,
    "--connected-folder-selection-border": identity.borderColor,
    "--connected-folder-selection-surface": identity.softColor,
    "--connected-folder-on-accent": identity.onAccentColor,
    "--connected-folder-on-primary-accent": identity.onPrimaryAccentColor,
    "--connected-folder-picker-color": identity.color,
  } as CSSProperties;
}

export function connectedFolderBannerImageStyle(framing: ConnectedFolderAppearanceBannerFraming): CSSProperties {
  return { objectPosition: `${framing.x}% ${framing.y}%`, transform: `scale(${framing.zoom})`, transformOrigin: `${framing.x}% ${framing.y}%` };
}

function defaultConnectedFolderIconName(_connectedFolder: ConnectedFolderSummary): string {
  return "folder";
}

async function processConnectedFolderBannerImageFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or BMP image.");
  }
  if (file.size > maxConnectedFolderBannerImageFileBytes) {
    throw new Error("Image is larger than 12 MB. Choose a smaller image.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const maxWidth = 1600;
    const maxHeight = 640;
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process the image.");
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      if (dataUrl.startsWith("data:image/webp") && dataUrl.length <= maxConnectedFolderBannerImageDataUrlLength) return dataUrl;
    }
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.72);
    if (jpegDataUrl.length <= maxConnectedFolderBannerImageDataUrlLength) return jpegDataUrl;
    throw new Error("Image is too detailed to store locally. Try a simpler or smaller image.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageElement(sourceUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that file as an image."));
    image.src = sourceUrl;
  });
}

export { readableTextColorOn } from "./color-contrast";
export { processConnectedFolderBannerImageFile, connectedFolderIdentityFor, connectedFolderIdentityStyle };
export type { ConnectedFolderIdentity };
