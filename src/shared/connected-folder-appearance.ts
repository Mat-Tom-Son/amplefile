export const connectedFolderAppearanceStateVersion = 2 as const;
export const connectedFolderAppearanceProposalVersion = 1 as const;
export const connectedFolderAppearanceProposalKind = "amplefile.connected-folder-appearance" as const;
export const maxConnectedFolderAppearanceBannerImageDataUrlLength = 700_000;
export const connectedFolderAppearanceBannerNames = [
  "none",
  "classic",
  "mist",
  "horizon",
  "aurora",
  "halftone",
  "blueprint",
  "pinstripe",
  "ribbon",
  "bold",
] as const;

export type ConnectedFolderAppearanceMode = "light" | "dark";
export type ConnectedFolderAppearanceEnforcement = "guided" | "warned" | "off";
export type ConnectedFolderAppearanceBannerImagePosition = "top" | "center" | "bottom";
export const connectedFolderAppearanceBannerPresetIds = ["tide", "ember", "fold", "dusk"] as const;
export type ConnectedFolderAppearanceBannerPresetId = typeof connectedFolderAppearanceBannerPresetIds[number];
export interface ConnectedFolderAppearanceBannerFraming { x: number; y: number; zoom: number }
/** How the banner sits above the Connected Folder's pane. Card is the original. */
export const connectedFolderAppearanceBannerLayouts = ["card", "compact", "band", "cover"] as const;
export type ConnectedFolderAppearanceBannerLayout = typeof connectedFolderAppearanceBannerLayouts[number];
/** The icon beside the name on the banner (2026-11-05). */
export const connectedFolderAppearanceBannerIconStyles = ["none", "plain", "square", "circle"] as const;
export type ConnectedFolderAppearanceBannerIconStyle = typeof connectedFolderAppearanceBannerIconStyles[number];
/** What sits behind the name on the banner (2026-11-05). Accent is the Connected Folder color. */
export const connectedFolderAppearanceBannerTitleFills = ["frosted", "solid", "accent", "none"] as const;
export type ConnectedFolderAppearanceBannerTitleFill = typeof connectedFolderAppearanceBannerTitleFills[number];

export function normalizeConnectedFolderAppearanceBannerFraming(value: unknown): ConnectedFolderAppearanceBannerFraming | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 100
    || typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 100
    || typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < 1 || zoom > 2) return undefined;
  return { x, y, zoom };
}

export interface AccentIdentity {
  schema: 2;
  hue: number;
  chroma: number;
  referenceHex: string;
}

export interface ConnectedFolderAppearanceCustomization {
  /** Legacy renderer-local fields. They remain readable until the next explicit edit. */
  color?: string;
  color2?: string;
  schema?: 1 | 2;
  primary?: AccentIdentity;
  secondary?: AccentIdentity;
  iconName?: string;
  bannerName?: string;
  bannerImage?: string | null;
  bannerImagePosition?: ConnectedFolderAppearanceBannerImagePosition;
  bannerPreset?: ConnectedFolderAppearanceBannerPresetId;
  bannerFraming?: ConnectedFolderAppearanceBannerFraming;
  bannerLayout?: ConnectedFolderAppearanceBannerLayout;
  bannerIconStyle?: ConnectedFolderAppearanceBannerIconStyle;
  bannerTitleFill?: ConnectedFolderAppearanceBannerTitleFill;
}

export type ConnectedFolderAppearanceCustomizationMap = Record<string, ConnectedFolderAppearanceCustomization>;

export interface ConnectedFolderAppearanceState {
  version: typeof connectedFolderAppearanceStateVersion;
  revision: number;
  customizations: ConnectedFolderAppearanceCustomizationMap;
}

export interface ConnectedFolderAppearanceProposal {
  kind: typeof connectedFolderAppearanceProposalKind;
  version: typeof connectedFolderAppearanceProposalVersion;
  name: string;
  description?: string;
  target?: {
    connectedFolderId?: string;
    connectedFolderName?: string;
  };
  customization: ConnectedFolderAppearanceCustomization;
  createdBy?: "codex" | "claude-code" | "human" | "other";
}

export interface ResolverGround {
  mode: ConnectedFolderAppearanceMode;
  surface: string;
  canvas: string;
  softAlpha: number;
}

export interface AppearanceContrastAudit {
  role: "textBody" | "textUi" | "glyph" | "onSolid" | "onSolidMuted" | "borderState" | "borderDecor" | "indicator";
  foreground: string;
  backgrounds: string[];
  wcagTarget: number;
  apcaTarget: number | null;
  wcag: number;
  apca: number;
  passes: boolean;
}

export interface ResolvedAccentPalette {
  mode: ConnectedFolderAppearanceMode;
  textBody: string;
  textUi: string;
  glyph: string;
  solid: string;
  onSolid: string;
  onSolidMuted: string;
  softFill: string;
  borderState: string;
  borderDecor: string;
  focusRing: string;
  indicator: string;
  bannerPrimary: string;
  bannerSecondary: string;
  bannerBase: string;
  audit: AppearanceContrastAudit[];
  meta: {
    chromaUsed: number;
    chromaReducedBy: string[];
    unsatisfiable: string[];
  };
}

export interface ResolvedConnectedFolderAppearance {
  light: ResolvedAccentPalette;
  dark: ResolvedAccentPalette;
  passes: boolean;
  uncertified: Array<"banner-gradient" | "banner-image">;
}

export interface NormalizeConnectedFolderAppearanceOptions {
  allowedConnectedFolderIds?: ReadonlySet<string>;
  allowedIconNames?: ReadonlySet<string>;
  allowedBannerNames?: ReadonlySet<string>;
}

export const defaultConnectedFolderAppearanceGrounds: Record<ConnectedFolderAppearanceMode, ResolverGround> = {
  light: { mode: "light", surface: "#ffffff", canvas: "#f5f6f8", softAlpha: 0.13 },
  dark: { mode: "dark", surface: "#171a21", canvas: "#111318", softAlpha: 0.13 },
};

const darkForeground = "#182846";
const lightForeground = "#ffffff";
const epsilon = 0.000_001;

export function normalizeHexColor(value: unknown, fallback = "#60646c"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

export function normalizeConnectedFolderAppearanceCustomization(
  value: unknown,
  options: NormalizeConnectedFolderAppearanceOptions = {},
): ConnectedFolderAppearanceCustomization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const customization: ConnectedFolderAppearanceCustomization = {};
  const primary = normalizeAccentIdentity(record.primary);
  const secondary = normalizeAccentIdentity(record.secondary);

  if (primary) {
    customization.schema = 2;
    customization.primary = primary;
  } else if (isHexColor(record.color)) {
    customization.schema = 1;
    customization.color = normalizeHexColor(record.color);
  }
  if (secondary) {
    customization.schema = 2;
    customization.secondary = secondary;
  } else if (isHexColor(record.color2)) {
    customization.color2 = normalizeHexColor(record.color2);
  }

  if (typeof record.iconName === "string") {
    const iconName = record.iconName.trim().toLowerCase();
    if (/^[a-z0-9-]{1,64}$/.test(iconName)
      && (!options.allowedIconNames || options.allowedIconNames.has(iconName))) {
      customization.iconName = iconName;
    }
  }
  if (typeof record.bannerName === "string") {
    const bannerName = record.bannerName.trim().toLowerCase();
    if (/^[a-z0-9-]{1,32}$/.test(bannerName)
      && (!options.allowedBannerNames || options.allowedBannerNames.has(bannerName))) {
      customization.bannerName = bannerName;
    }
  }
  const bannerImage = normalizeConnectedFolderAppearanceBannerImage(record.bannerImage);
  if (bannerImage) customization.bannerImage = bannerImage;
  if (record.bannerImage === null) customization.bannerImage = null;
  if (record.bannerImagePosition === "top"
    || record.bannerImagePosition === "center"
    || record.bannerImagePosition === "bottom") {
    customization.bannerImagePosition = record.bannerImagePosition;
  }
  if (connectedFolderAppearanceBannerPresetIds.includes(record.bannerPreset as ConnectedFolderAppearanceBannerPresetId)) {
    customization.bannerPreset = record.bannerPreset as ConnectedFolderAppearanceBannerPresetId;
  }
  const framing = normalizeConnectedFolderAppearanceBannerFraming(record.bannerFraming);
  if (framing) customization.bannerFraming = framing;
  if (connectedFolderAppearanceBannerLayouts.includes(record.bannerLayout as ConnectedFolderAppearanceBannerLayout)) {
    customization.bannerLayout = record.bannerLayout as ConnectedFolderAppearanceBannerLayout;
  }
  if (connectedFolderAppearanceBannerIconStyles.includes(record.bannerIconStyle as ConnectedFolderAppearanceBannerIconStyle)) {
    customization.bannerIconStyle = record.bannerIconStyle as ConnectedFolderAppearanceBannerIconStyle;
  }
  if (connectedFolderAppearanceBannerTitleFills.includes(record.bannerTitleFill as ConnectedFolderAppearanceBannerTitleFill)) {
    customization.bannerTitleFill = record.bannerTitleFill as ConnectedFolderAppearanceBannerTitleFill;
  }

  return hasConnectedFolderAppearanceCustomization(customization) ? customization : {};
}

export function normalizeConnectedFolderAppearanceCustomizations(
  value: unknown,
  options: NormalizeConnectedFolderAppearanceOptions = {},
): ConnectedFolderAppearanceCustomizationMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: ConnectedFolderAppearanceCustomizationMap = {};
  for (const [connectedFolderId, candidate] of Object.entries(value)) {
    if (!connectedFolderId || options.allowedConnectedFolderIds && !options.allowedConnectedFolderIds.has(connectedFolderId)) continue;
    const customization = normalizeConnectedFolderAppearanceCustomization(candidate, options);
    if (hasConnectedFolderAppearanceCustomization(customization)) normalized[connectedFolderId] = customization;
  }
  return normalized;
}

export function normalizeConnectedFolderAppearanceState(
  value: unknown,
  options: NormalizeConnectedFolderAppearanceOptions = {},
): ConnectedFolderAppearanceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connected Folder appearance state must be a JSON object.");
  const record = value as Record<string, unknown>;
  if (record.version !== connectedFolderAppearanceStateVersion) throw new Error("Connected Folder appearance state version is invalid.");
  const revision = typeof record.revision === "number"
    && Number.isSafeInteger(record.revision)
    && record.revision >= 0
    ? record.revision
    : 0;
  return {
    version: connectedFolderAppearanceStateVersion,
    revision,
    customizations: normalizeConnectedFolderAppearanceCustomizations(record.customizations, options),
  };
}

export function normalizeConnectedFolderAppearanceBannerImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(value)) return null;
  return value.length <= maxConnectedFolderAppearanceBannerImageDataUrlLength ? value : null;
}

export function hasConnectedFolderAppearanceCustomization(
  customization: ConnectedFolderAppearanceCustomization | null | undefined,
): boolean {
  if (!customization) return false;
  return Boolean(
    customization.primary
    || customization.secondary
    || customization.color
    || customization.color2
    || customization.iconName
    || customization.bannerName
    || customization.bannerImage
    || customization.bannerImagePosition
    || customization.bannerPreset
    || customization.bannerFraming
    || customization.bannerLayout
    || customization.bannerIconStyle
    || customization.bannerTitleFill,
  );
}

/** The colors a Connected Folder can start in before anyone chooses one. */
export const defaultConnectedFolderAccents: ReadonlyArray<{ label: string; hex: string }> = [
  { label: "Slate", hex: "#60646c" },
  { label: "Red", hex: "#ce2c31" },
  { label: "Orange", hex: "#cc4e00" },
  { label: "Amber", hex: "#ab6400" },
  { label: "Moss", hex: "#5c7c2e" },
  { label: "Green", hex: "#1a7f37" },
  { label: "Cyan", hex: "#0e7490" },
  { label: "Blue", hex: "#0d74ce" },
  { label: "Violet", hex: "#6550b9" },
  { label: "Plum", hex: "#953ea3" },
  { label: "Pink", hex: "#c2298a" },
  { label: "Brown", hex: "#815e46" },
];

/** The starting color a Connected Folder's id picks when nothing is saved for it. */
export function defaultConnectedFolderAccent(connectedFolderId: string): { label: string; hex: string } {
  let hash = 0;
  for (const character of connectedFolderId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return defaultConnectedFolderAccents[hash % defaultConnectedFolderAccents.length] ?? defaultConnectedFolderAccents[0]!;
}

/**
 * A new Connected Folder's starting color: one the fewest other Connected Folders use,
 * so they stay easy to tell apart (2026-10-30). Its id's own pick wins a tie,
 * and later ties go to the next color along from it.
 */
export function startingConnectedFolderAccentHex(connectedFolderId: string, otherAccentHexes: readonly string[]): string {
  const uses = new Map(defaultConnectedFolderAccents.map((accent) => [accent.hex, 0]));
  for (const value of otherAccentHexes) {
    const hex = normalizeHexColor(value, "");
    const count = uses.get(hex);
    if (count !== undefined) uses.set(hex, count + 1);
  }
  const fewest = Math.min(...uses.values());
  const start = defaultConnectedFolderAccents.indexOf(defaultConnectedFolderAccent(connectedFolderId));
  for (let offset = 0; offset < defaultConnectedFolderAccents.length; offset += 1) {
    const accent = defaultConnectedFolderAccents[(start + offset) % defaultConnectedFolderAccents.length]!;
    if (uses.get(accent.hex) === fewest) return accent.hex;
  }
  return defaultConnectedFolderAccent(connectedFolderId).hex;
}

export function accentIdentityFromHex(value: string): AccentIdentity {
  const referenceHex = normalizeHexColor(value);
  const { l: _lightness, c: chroma, h: hue } = hexToOklch(referenceHex);
  return {
    schema: 2,
    hue: round(hue, 4),
    chroma: round(chroma, 6),
    referenceHex,
  };
}

export function primaryAccentIdentity(
  customization: ConnectedFolderAppearanceCustomization | null | undefined,
  fallbackHex: string,
): AccentIdentity {
  return normalizeAccentIdentity(customization?.primary)
    ?? accentIdentityFromHex(normalizeHexColor(customization?.color, normalizeHexColor(fallbackHex)));
}

export function secondaryAccentIdentity(
  customization: ConnectedFolderAppearanceCustomization | null | undefined,
  primary: AccentIdentity,
): AccentIdentity {
  return normalizeAccentIdentity(customization?.secondary)
    ?? (customization?.color2 ? accentIdentityFromHex(customization.color2) : primary);
}

export function createConnectedFolderAppearanceProposal(input: {
  name: string;
  description?: string;
  target?: ConnectedFolderAppearanceProposal["target"];
  customization: ConnectedFolderAppearanceCustomization;
  createdBy?: ConnectedFolderAppearanceProposal["createdBy"];
}): ConnectedFolderAppearanceProposal {
  const name = normalizeShortText(input.name, 80);
  if (!name) throw new Error("An appearance proposal name is required.");
  const customization = upgradeConnectedFolderAppearanceCustomization(input.customization);
  if (!hasConnectedFolderAppearanceCustomization(customization)) throw new Error("The appearance proposal is empty.");
  const description = normalizeShortText(input.description, 280);
  const connectedFolderId = normalizeShortText(input.target?.connectedFolderId, 160);
  const connectedFolderName = normalizeShortText(input.target?.connectedFolderName, 120);
  const target = connectedFolderId || connectedFolderName ? { ...(connectedFolderId ? { connectedFolderId } : {}), ...(connectedFolderName ? { connectedFolderName } : {}) } : undefined;
  return {
    kind: connectedFolderAppearanceProposalKind,
    version: connectedFolderAppearanceProposalVersion,
    name,
    ...(description ? { description } : {}),
    ...(target ? { target } : {}),
    customization,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  };
}

export function parseConnectedFolderAppearanceProposal(value: unknown): ConnectedFolderAppearanceProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This is not an AmpleFile appearance proposal.");
  const record = value as Record<string, unknown>;
  if (record.kind !== connectedFolderAppearanceProposalKind || record.version !== connectedFolderAppearanceProposalVersion) {
    throw new Error("This appearance proposal uses an unsupported format.");
  }
  const targetRecord = record.target && typeof record.target === "object" && !Array.isArray(record.target)
    ? record.target as Record<string, unknown>
    : undefined;
  if (targetRecord && ("workspaceId" in targetRecord || "workspaceName" in targetRecord)) {
    throw new Error("Legacy appearance target fields are not supported.");
  }
  const createdBy = record.createdBy === "codex"
    || record.createdBy === "claude-code"
    || record.createdBy === "human"
    || record.createdBy === "other"
    ? record.createdBy
    : undefined;
  return createConnectedFolderAppearanceProposal({
    name: typeof record.name === "string" ? record.name : "",
    description: typeof record.description === "string" ? record.description : undefined,
    target: targetRecord ? {
      connectedFolderId: typeof targetRecord.connectedFolderId === "string" ? targetRecord.connectedFolderId : undefined,
      connectedFolderName: typeof targetRecord.connectedFolderName === "string" ? targetRecord.connectedFolderName : undefined,
    } : undefined,
    customization: normalizeConnectedFolderAppearanceCustomization(record.customization),
    createdBy,
  });
}

export function upgradeConnectedFolderAppearanceCustomization(
  value: ConnectedFolderAppearanceCustomization,
): ConnectedFolderAppearanceCustomization {
  const normalized = normalizeConnectedFolderAppearanceCustomization(value);
  const primary = normalized.primary ?? (normalized.color ? accentIdentityFromHex(normalized.color) : undefined);
  const secondary = normalized.secondary ?? (normalized.color2 ? accentIdentityFromHex(normalized.color2) : undefined);
  const upgraded: ConnectedFolderAppearanceCustomization = {
    ...(primary || secondary ? { schema: 2 as const } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(normalized.iconName ? { iconName: normalized.iconName } : {}),
    ...(normalized.bannerName ? { bannerName: normalized.bannerName } : {}),
    ...(normalized.bannerImage !== undefined ? { bannerImage: normalized.bannerImage } : {}),
    ...(normalized.bannerImagePosition ? { bannerImagePosition: normalized.bannerImagePosition } : {}),
    ...(normalized.bannerPreset ? { bannerPreset: normalized.bannerPreset } : {}),
    ...(normalized.bannerFraming ? { bannerFraming: normalized.bannerFraming } : {}),
    ...(normalized.bannerLayout ? { bannerLayout: normalized.bannerLayout } : {}),
    ...(normalized.bannerIconStyle ? { bannerIconStyle: normalized.bannerIconStyle } : {}),
    ...(normalized.bannerTitleFill ? { bannerTitleFill: normalized.bannerTitleFill } : {}),
  };
  return upgraded;
}

export function resolveConnectedFolderAppearance(input: {
  primary: AccentIdentity;
  secondary?: AccentIdentity;
  enforcement?: ConnectedFolderAppearanceEnforcement;
  bannerName?: string;
  hasBannerImage?: boolean;
  grounds?: Record<ConnectedFolderAppearanceMode, ResolverGround>;
}): ResolvedConnectedFolderAppearance {
  const enforcement = input.enforcement ?? "guided";
  const grounds = input.grounds ?? defaultConnectedFolderAppearanceGrounds;
  const light = resolveAccent(input.primary, grounds.light, enforcement, input.secondary);
  const dark = resolveAccent(input.primary, grounds.dark, enforcement, input.secondary);
  const uncertified: ResolvedConnectedFolderAppearance["uncertified"] = [];
  if (input.bannerName && input.bannerName !== "none") uncertified.push("banner-gradient");
  if (input.hasBannerImage) uncertified.push("banner-image");
  return {
    light,
    dark,
    passes: light.audit.every((entry) => entry.passes) && dark.audit.every((entry) => entry.passes),
    uncertified,
  };
}

export function resolveAccent(
  identity: AccentIdentity,
  ground: ResolverGround,
  enforcement: ConnectedFolderAppearanceEnforcement = "guided",
  secondaryIdentity: AccentIdentity = identity,
): ResolvedAccentPalette {
  const normalizedIdentity = normalizeAccentIdentity(identity) ?? accentIdentityFromHex("#60646c");
  const normalizedSecondary = normalizeAccentIdentity(secondaryIdentity) ?? normalizedIdentity;
  const surface = normalizeHexColor(ground.surface, defaultConnectedFolderAppearanceGrounds[ground.mode].surface);
  const canvas = normalizeHexColor(ground.canvas, defaultConnectedFolderAppearanceGrounds[ground.mode].canvas);
  const softAlpha = clamp(ground.softAlpha, 0.04, 0.3);
  const solidCandidate = ground.mode === "light"
    ? normalizedIdentity.referenceHex
    : colorForIdentity(normalizedIdentity, Math.max(hexToOklch(normalizedIdentity.referenceHex).l, 0.64)).hex;
  const solidChoice = solveSolidAndOnColor(normalizedIdentity, solidCandidate, ground.mode, enforcement);
  const onSolidMuted = solveMutedOnSolid(solidChoice.onSolid, solidChoice.solid, enforcement);
  const softFill = compositeHex(solidChoice.solid, surface, softAlpha);
  const textBody = solveForeground(normalizedIdentity, [surface, softFill], ground.mode, 4.5, 75, enforcement);
  const textUi = solveForeground(normalizedIdentity, [surface, softFill], ground.mode, 4.5, 75, enforcement);
  const glyph = solveForeground(normalizedIdentity, [surface, softFill], ground.mode, 3, 45, enforcement);
  const borderState = solveForeground(normalizedIdentity, [surface], ground.mode, 3, 45, enforcement);
  const borderDecor = solveForeground(normalizedIdentity, [surface], ground.mode, 1.5, null, enforcement);
  const indicator = solveForeground(normalizedIdentity, [surface], ground.mode, 3, 45, enforcement);
  const focusRing = compositeHex(borderState.hex, surface, softAlpha);
  const bannerPrimary = normalizedIdentity.referenceHex;
  const bannerSecondary = normalizedSecondary.referenceHex;
  const solved = [
    ["textBody", textBody],
    ["textUi", textUi],
    ["glyph", glyph],
    ["borderState", borderState],
    ["borderDecor", borderDecor],
    ["indicator", indicator],
  ] as const;
  const audits: AppearanceContrastAudit[] = [
    auditRole("textBody", textBody.hex, [surface, softFill], 4.5, 75, enforcement),
    auditRole("textUi", textUi.hex, [surface, softFill], 4.5, 75, enforcement),
    auditRole("glyph", glyph.hex, [surface, softFill], 3, 45, enforcement),
    auditRole("onSolid", solidChoice.onSolid, [solidChoice.solid], 4.5, 75, enforcement),
    auditRole("onSolidMuted", onSolidMuted, [solidChoice.solid], 4.5, 60, enforcement),
    auditRole("borderState", borderState.hex, [surface], 3, 45, enforcement),
    auditRole("borderDecor", borderDecor.hex, [surface], 1.5, null, enforcement),
    auditRole("indicator", indicator.hex, [surface], 3, 45, enforcement),
  ];
  const reduced = solved.filter(([, value]) => value.chroma + epsilon < normalizedIdentity.chroma);
  const unsatisfiable = audits.filter((entry) => !entry.passes).map((entry) => entry.role);
  return {
    mode: ground.mode,
    textBody: textBody.hex,
    textUi: textUi.hex,
    glyph: glyph.hex,
    solid: solidChoice.solid,
    onSolid: solidChoice.onSolid,
    onSolidMuted,
    softFill,
    borderState: borderState.hex,
    borderDecor: borderDecor.hex,
    focusRing,
    indicator: indicator.hex,
    bannerPrimary,
    bannerSecondary,
    bannerBase: canvas,
    audit: audits,
    meta: {
      chromaUsed: round(Math.min(normalizedIdentity.chroma, ...solved.map(([, value]) => value.chroma)), 6),
      chromaReducedBy: reduced.map(([role]) => role),
      unsatisfiable,
    },
  };
}

export function wcagContrast(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(normalizeHexColor(foreground));
  const backgroundLuminance = relativeLuminance(normalizeHexColor(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** APCA-W3 0.1.9-style Lc calculation. Sign indicates contrast polarity. */
export function apcaContrast(foreground: string, background: string): number {
  let textY = apcaLuminance(normalizeHexColor(foreground));
  let backgroundY = apcaLuminance(normalizeHexColor(background));
  const blackThreshold = 0.022;
  const blackClamp = 1.414;
  if (textY < blackThreshold) textY += (blackThreshold - textY) ** blackClamp;
  if (backgroundY < blackThreshold) backgroundY += (blackThreshold - backgroundY) ** blackClamp;
  if (Math.abs(backgroundY - textY) < 0.0005) return 0;
  if (backgroundY > textY) {
    const sapc = (backgroundY ** 0.56 - textY ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (backgroundY ** 0.65 - textY ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}

export function compositeHex(foreground: string, background: string, alpha: number): string {
  const first = hexToRgb(normalizeHexColor(foreground));
  const second = hexToRgb(normalizeHexColor(background));
  const amount = clamp(alpha, 0, 1);
  return rgbToHex({
    r: first.r * amount + second.r * (1 - amount),
    g: first.g * amount + second.g * (1 - amount),
    b: first.b * amount + second.b * (1 - amount),
  });
}

export function hexToOklch(value: string): { l: number; c: number; h: number } {
  const rgb = hexToRgb(normalizeHexColor(value));
  const red = srgbToLinear(rgb.r / 255);
  const green = srgbToLinear(rgb.g / 255);
  const blue = srgbToLinear(rgb.b / 255);
  const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
  const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
  const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const b = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  const chroma = Math.sqrt(a * a + b * b);
  const rawHue = Math.atan2(b, a) * 180 / Math.PI;
  return { l: lightness, c: chroma, h: chroma < epsilon ? 0 : (rawHue + 360) % 360 };
}

function normalizeAccentIdentity(value: unknown): AccentIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== 2
    || typeof record.hue !== "number"
    || typeof record.chroma !== "number"
    || !Number.isFinite(record.hue)
    || !Number.isFinite(record.chroma)
    || !isHexColor(record.referenceHex)) return null;
  // referenceHex is the compatibility anchor and the only independently
  // chosen colour in schema 2. Re-derive metadata so a forged or stale
  // hue/chroma pair cannot steer the resolver away from the reviewed value.
  return accentIdentityFromHex(normalizeHexColor(record.referenceHex));
}

function solveMutedOnSolid(
  onSolid: string,
  solid: string,
  enforcement: ConnectedFolderAppearanceEnforcement,
): string {
  let candidate = compositeHex(onSolid, solid, 0.76);
  for (let alpha = 0.76; alpha <= 1 + epsilon; alpha += 0.01) {
    candidate = compositeHex(onSolid, solid, Math.min(alpha, 1));
    if (contrastPasses(
      wcagContrast(candidate, solid),
      Math.abs(apcaContrast(candidate, solid)),
      4.5,
      60,
      enforcement,
    )) return candidate;
  }
  return onSolid;
}

function solveSolidAndOnColor(
  identity: AccentIdentity,
  initialSolid: string,
  mode: ConnectedFolderAppearanceMode,
  enforcement: ConnectedFolderAppearanceEnforcement,
): { solid: string; onSolid: string } {
  const initialOn = chooseOnColor(initialSolid, enforcement);
  if (initialOn) return { solid: initialSolid, onSolid: initialOn };
  const referenceLightness = hexToOklch(initialSolid).l;
  const direction = mode === "dark" ? 1 : -1;
  for (let step = 1; step <= 250; step += 1) {
    const candidate = colorForIdentity(identity, clamp(referenceLightness + direction * step * 0.002, 0.02, 0.98)).hex;
    const onColor = chooseOnColor(candidate, enforcement);
    if (onColor) return { solid: candidate, onSolid: onColor };
  }
  const whiteWcag = wcagContrast(lightForeground, initialSolid);
  const darkWcag = wcagContrast(darkForeground, initialSolid);
  return { solid: initialSolid, onSolid: whiteWcag >= darkWcag ? lightForeground : darkForeground };
}

function chooseOnColor(background: string, enforcement: ConnectedFolderAppearanceEnforcement): string | null {
  const candidates = [lightForeground, darkForeground]
    .map((foreground) => ({
      foreground,
      wcag: wcagContrast(foreground, background),
      apca: Math.abs(apcaContrast(foreground, background)),
    }))
    .sort((left, right) => Math.min(right.wcag / 4.5, right.apca / 75) - Math.min(left.wcag / 4.5, left.apca / 75));
  const passing = candidates.find((candidate) => contrastPasses(candidate.wcag, candidate.apca, 4.5, 75, enforcement));
  return passing?.foreground ?? null;
}

function solveForeground(
  identity: AccentIdentity,
  backgrounds: string[],
  mode: ConnectedFolderAppearanceMode,
  wcagTarget: number,
  apcaTarget: number | null,
  enforcement: ConnectedFolderAppearanceEnforcement,
): { hex: string; chroma: number } {
  const start = clamp(hexToOklch(identity.referenceHex).l, 0.01, 0.99);
  const direction = mode === "dark" ? 1 : -1;
  let best = colorForIdentity(identity, start);
  for (let step = 0; step <= 500; step += 1) {
    const lightness = clamp(start + direction * step * 0.002, 0.01, 0.99);
    const candidate = colorForIdentity(identity, lightness);
    const passes = backgrounds.every((background) => contrastPasses(
      wcagContrast(candidate.hex, background),
      Math.abs(apcaContrast(candidate.hex, background)),
      wcagTarget,
      apcaTarget,
      enforcement,
    ));
    best = candidate;
    if (passes) return candidate;
    if ((direction < 0 && lightness === 0.01) || (direction > 0 && lightness === 0.99)) break;
  }
  return best;
}

function colorForIdentity(identity: AccentIdentity, lightness: number): { hex: string; chroma: number } {
  let low = 0;
  let high = identity.chroma;
  let best = oklchToSrgb(lightness, 0, identity.hue);
  for (let iteration = 0; iteration < 22; iteration += 1) {
    const chroma = (low + high) / 2;
    const candidate = oklchToSrgb(lightness, chroma, identity.hue);
    if (candidate.inGamut) {
      low = chroma;
      best = candidate;
    } else {
      high = chroma;
    }
  }
  return { hex: rgbToHex(best), chroma: low };
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): { r: number; g: number; b: number; inGamut: boolean } {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const redLinear = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const greenLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blueLinear = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const red = linearToSrgb(redLinear);
  const green = linearToSrgb(greenLinear);
  const blue = linearToSrgb(blueLinear);
  const inGamut = red >= -epsilon && red <= 1 + epsilon
    && green >= -epsilon && green <= 1 + epsilon
    && blue >= -epsilon && blue <= 1 + epsilon;
  return {
    r: clamp(red, 0, 1) * 255,
    g: clamp(green, 0, 1) * 255,
    b: clamp(blue, 0, 1) * 255,
    inGamut,
  };
}

function auditRole(
  role: AppearanceContrastAudit["role"],
  foreground: string,
  backgrounds: string[],
  wcagTarget: number,
  apcaTarget: number | null,
  enforcement: ConnectedFolderAppearanceEnforcement,
): AppearanceContrastAudit {
  const wcag = Math.min(...backgrounds.map((background) => wcagContrast(foreground, background)));
  const apca = Math.min(...backgrounds.map((background) => Math.abs(apcaContrast(foreground, background))));
  return {
    role,
    foreground,
    backgrounds,
    wcagTarget,
    apcaTarget,
    wcag: round(wcag, 2),
    apca: round(apca, 1),
    passes: contrastPasses(wcag, apca, wcagTarget, apcaTarget, enforcement),
  };
}

function contrastPasses(
  wcag: number,
  apca: number,
  wcagTarget: number,
  apcaTarget: number | null,
  enforcement: ConnectedFolderAppearanceEnforcement,
): boolean {
  if (enforcement === "off") return true;
  return wcag + epsilon >= wcagTarget && (apcaTarget === null || apca + epsilon >= apcaTarget);
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  return 0.2126 * wcagChannel(rgb.r / 255) + 0.7152 * wcagChannel(rgb.g / 255) + 0.0722 * wcagChannel(rgb.b / 255);
}

function apcaLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  return 0.2126729 * (rgb.r / 255) ** 2.4
    + 0.7151522 * (rgb.g / 255) ** 2.4
    + 0.072175 * (rgb.b / 255) ** 2.4;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function wcagChannel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function normalizeShortText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
