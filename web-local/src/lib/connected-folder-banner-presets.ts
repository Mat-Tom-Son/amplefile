import type { ConnectedFolderAppearanceBannerPresetId } from "../../../src/shared/connected-folder-appearance";

export const connectedFolderBannerPresets = [
  { id: "tide", label: "Tide", image: new URL("../assets/banners/tide.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/tide-thumb.webp", import.meta.url).href },
  { id: "ember", label: "Ember", image: new URL("../assets/banners/ember.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/ember-thumb.webp", import.meta.url).href },
  { id: "fold", label: "Fold", image: new URL("../assets/banners/fold.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/fold-thumb.webp", import.meta.url).href },
  { id: "dusk", label: "Dusk", image: new URL("../assets/banners/dusk.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/dusk-thumb.webp", import.meta.url).href },
] as const satisfies ReadonlyArray<{ id: ConnectedFolderAppearanceBannerPresetId; label: string; image: string; thumbnail: string }>;

export function connectedFolderBannerPresetFor(id: unknown) {
  return connectedFolderBannerPresets.find((preset) => preset.id === id);
}
