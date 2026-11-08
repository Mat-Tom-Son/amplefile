
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDownload20Regular, ArrowClockwise20Regular, ArrowReset20Regular, ArrowUndo20Regular, ArrowUpload20Regular, Checkmark20Regular, ChevronDown20Regular, ChevronLeft20Regular, ChevronRight20Regular, Search20Regular, Warning20Regular } from "@fluentui/react-icons";
import { accentIdentityFromHex, createConnectedFolderAppearanceProposal, parseConnectedFolderAppearanceProposal, upgradeConnectedFolderAppearanceCustomization } from "../../../../src/shared/connected-folder-appearance";
import { filterConnectedFolderIconOptions, connectedFolderIconOptions, connectedFolderIconGroups, type ConnectedFolderIconGroupId } from "../../connected-folder-icons";
import { errorText } from "../../lib/api";
import { normalizeConnectedFolderCustomizations } from "../../lib/connected-folder-customization";
import { normalizeConnectedFolderColor, processConnectedFolderBannerImageFile, connectedFolderColorOptions, connectedFolderIdentityStyle, type ConnectedFolderIdentity } from "../../lib/connected-folder-identity";
import { ConnectedFolderBannerPreview } from "../chrome/ConnectedFolderBannerPreview";
import { readableTextColorOn } from "../../lib/color-contrast";
import type { ConnectedFolderCustomization, ConnectedFolderCustomizationPatch, ConnectedFolderSummary } from "../../types";
import { ConnectedFolderIconGlyph } from "../chrome/common";

function ConnectedFolderNameEditor({
  connectedFolder,
  onRenameConnectedFolder,
}: {
  connectedFolder: ConnectedFolderSummary;
  onRenameConnectedFolder: (connectedFolder: ConnectedFolderSummary, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(connectedFolder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(connectedFolder.name);
    setSaving(false);
    setError(null);
  }, [connectedFolder.id, connectedFolder.name]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a Connected Folder name.");
      return;
    }
    if (nextName === connectedFolder.name) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameConnectedFolder(connectedFolder, nextName);
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || saving || name === connectedFolder.name) return;
    event.preventDefault();
    setName(connectedFolder.name);
    setError(null);
  }

  return (
    <div className="connected-folder-name-editor">
      <form className="connected-folder-name-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={80}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={`Connected Folder name for ${connectedFolder.name}`}
          />
        </label>
        <button className="connected-folder-name-save" type="submit" disabled={saving || !name.trim() || name.trim() === connectedFolder.name} aria-label={saving ? "Saving Name" : undefined}>
          {saving ? <ArrowClockwise20Regular className="spin" aria-hidden="true" /> : "Save"}
        </button>
      </form>
      {error ? <span className="connected-folder-name-error" role="alert">{error}</span> : null}
    </div>
  );
}

export const connectedFolderIconPageSize = 96;

function ConnectedFolderAppearancePanel({
  connectedFolder,
  identity,
  customization,
  canUndo,
  onCustomizeConnectedFolder,
  onReplaceConnectedFolder,
  onUndoConnectedFolder,
  onResetConnectedFolder,
  preview,
}: {
  connectedFolder: ConnectedFolderSummary;
  identity: ConnectedFolderIdentity;
  customization?: ConnectedFolderCustomization;
  canUndo: boolean;
  /** Shown in place of the banner previews, for a layout that draws no banner. */
  preview?: ReactNode;
  onCustomizeConnectedFolder: (connectedFolderId: string, patch: ConnectedFolderCustomizationPatch) => void;
  onReplaceConnectedFolder: (connectedFolderId: string, customization: ConnectedFolderCustomization) => void;
  onUndoConnectedFolder: (connectedFolderId: string) => void;
  onResetConnectedFolder: (connectedFolderId: string) => void;
}) {
  const [iconGroup, setIconGroup] = useState<ConnectedFolderIconGroupId>("popular");
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [iconPage, setIconPage] = useState(0);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const previousIconConnectedFolderRef = useRef(connectedFolder.id);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const connectedFolderId = connectedFolder.id;
  const matchingConnectedFolderIconOptions = useMemo(() => filterConnectedFolderIconOptions(iconSearchQuery, iconGroup), [iconSearchQuery, iconGroup]);
  const iconPageCount = Math.max(1, Math.ceil(matchingConnectedFolderIconOptions.length / connectedFolderIconPageSize));
  const visibleConnectedFolderIconOptions = matchingConnectedFolderIconOptions.slice(iconPage * connectedFolderIconPageSize, (iconPage + 1) * connectedFolderIconPageSize);
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    const changedConnectedFolder = previousIconConnectedFolderRef.current !== connectedFolderId;
    previousIconConnectedFolderRef.current = connectedFolderId;
    const options = changedConnectedFolder ? connectedFolderIconOptions : matchingConnectedFolderIconOptions;
    const selectedIconIndex = options.findIndex((option) => option.name === identity.iconName);
    setIconPage(selectedIconIndex < 0 ? 0 : Math.floor(selectedIconIndex / connectedFolderIconPageSize));
    if (!changedConnectedFolder) return;
    setIconSearchQuery("");
    setBannerUploadBusy(false);
    setBannerUploadError(null);
    setProposalImportError(null);
  }, [connectedFolderId, identity.iconName]);

  const appearancePasses = identity.resolved.passes;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processConnectedFolderBannerImageFile(file);
      onCustomizeConnectedFolder(connectedFolderId, { bannerImage, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined });
    } catch (uploadError) {
      setBannerUploadError(errorText(uploadError));
    } finally {
      setBannerUploadBusy(false);
    }
  }

  function exportAppearanceProposal() {
    setProposalImportError(null);
    const upgraded = upgradeConnectedFolderAppearanceCustomization(customization ?? {});
    const proposal = createConnectedFolderAppearanceProposal({
      name: `${connectedFolder.name} appearance`,
      description: "A safe, code-free Connected Folder appearance preset.",
      target: { connectedFolderId: connectedFolder.id, connectedFolderName: connectedFolder.name },
      customization: {
        ...upgraded,
        schema: 2,
        primary: upgraded.primary ?? accentIdentityFromHex(identity.color),
        ...(identity.hasCustomSecondary
          ? { secondary: upgraded.secondary ?? accentIdentityFromHex(identity.secondaryColor) }
          : {}),
      },
      createdBy: "human",
    });
    const blob = new Blob([`${JSON.stringify(proposal, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${connectedFolder.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "connected-folder"}-appearance.connected-folder.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function importAppearanceProposal(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setProposalImportError(null);
    try {
      if (file.size > 850_000) throw new Error("Appearance proposal is too large.");
      const proposal = parseConnectedFolderAppearanceProposal(JSON.parse(await file.text()));
      const normalized = normalizeConnectedFolderCustomizations(
        { [connectedFolderId]: proposal.customization },
        new Set([connectedFolderId]),
        new Set(connectedFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])])),
      )[connectedFolderId];
      if (!normalized) throw new Error("The proposal does not contain a supported appearance.");
      onReplaceConnectedFolder(connectedFolderId, normalized);
    } catch (caught) {
      setProposalImportError(errorText(caught));
    }
  }

  return (
    <div className="connected-folder-appearance-inner">
      <div className="connected-folder-appearance-toolbar">
        <button type="button" disabled={!canUndo} onClick={() => onUndoConnectedFolder(connectedFolderId)} title="Undo the last appearance change"><ArrowUndo20Regular />Undo</button>
        <div className="connected-folder-appearance-toolbar-actions">
          <button type="button" disabled={!customized} onClick={() => onResetConnectedFolder(connectedFolderId)}><ArrowReset20Regular />Reset</button>
          <details className="connected-folder-appearance-more">
            <summary aria-label="More Appearance Options">More<ChevronDown20Regular /></summary>
            <div>
              <button type="button" onClick={() => proposalFileInputRef.current?.click()}><ArrowUpload20Regular />Import</button>
              <button type="button" onClick={exportAppearanceProposal}><ArrowDownload20Regular />Export</button>
            </div>
          </details>
        </div>
      </div>
      <input ref={proposalFileInputRef} className="connected-folder-banner-file-input" type="file" accept=".json,application/json" onChange={(event) => void importAppearanceProposal(event)} tabIndex={-1} aria-hidden="true" />
      {proposalImportError ? <div className="connected-folder-appearance-import-error" role="alert">{proposalImportError}</div> : null}
      {preview ?? <ConnectedFolderBannerPreview identity={identity} name={connectedFolder.name} onFrame={(bannerFraming) => onCustomizeConnectedFolder(connectedFolderId, { bannerFraming })} />}
      {!appearancePasses ? <div className="connected-folder-appearance-audit warning" role="status"><Warning20Regular aria-hidden="true" /><span>Choose a higher-contrast accent.</span></div> : null}
      {/* One page with a section each; the previews above stay in view. */}
      <div className="connected-folder-appearance-sections">
        <section className="connected-folder-appearance-section" id="folder-appearance-section-icon" aria-labelledby="folder-appearance-heading-icon">
          <h3 id="folder-appearance-heading-icon">Icon</h3>
        <div className="connected-folder-icon-picker">
          <label className="connected-folder-icon-search">
            <Search20Regular aria-hidden="true" />
            <input
              type="search"
              value={iconSearchQuery}
              onChange={(event) => {
                setIconSearchQuery(event.currentTarget.value);
                setIconPage(0);
                if (event.currentTarget.value) setIconGroup("all");
              }}
              placeholder="Search icons"
              aria-label="Search Connected Folder icons"
            />
          </label>
          <div className="connected-folder-icon-categories" role="group" aria-label="Icon categories">
            {connectedFolderIconGroups.map((group) => <button key={group.id} type="button" aria-pressed={iconGroup === group.id} onClick={() => { setIconGroup(group.id); setIconSearchQuery(""); setIconPage(0); }}>{group.label}</button>)}
          </div>
          <div className="connected-folder-icon-browser">
            <div className="connected-folder-icon-grid" aria-label="Connected Folder Icon">
              {visibleConnectedFolderIconOptions.map((option) => {
                const Icon = option.Icon;
                return (
                  <button
                    className={identity.iconName === option.name ? "connected-folder-icon-option active" : "connected-folder-icon-option"}
                    key={option.name}
                    type="button"
                    onClick={() => onCustomizeConnectedFolder(connectedFolderId, { iconName: option.name })}
                    aria-label={`Use ${option.label} Icon`}
                    aria-pressed={identity.iconName === option.name}
                    title={option.label}
                  >
                    <ConnectedFolderIconGlyph icon={Icon} size={24} filled={identity.iconName === option.name} />
                  </button>
                );
              })}
              {!visibleConnectedFolderIconOptions.length ? <span className="connected-folder-icon-empty">No Icons Found</span> : null}
            </div>
          </div>
          {iconPageCount > 1 ? (
            <div className="connected-folder-icon-pages" aria-label="Icon pages">
              <button type="button" onClick={() => setIconPage((current) => Math.max(0, current - 1))} disabled={iconPage === 0} aria-label="Previous Icon Page"><ChevronLeft20Regular /></button>
              <span className="connected-folder-icon-pager-status">{iconPage + 1} / {iconPageCount}</span>
              <button type="button" onClick={() => setIconPage((current) => Math.min(iconPageCount - 1, current + 1))} disabled={iconPage >= iconPageCount - 1} aria-label="Next Icon Page"><ChevronRight20Regular /></button>
            </div>
          ) : null}
        </div>
        </section>
        <section className="connected-folder-appearance-section" id="folder-appearance-section-color" aria-labelledby="folder-appearance-heading-color">
          <h3 id="folder-appearance-heading-color">Color</h3>
      <div className="connected-folder-appearance-row colors">
        <div className="connected-folder-color-section-heading"><strong>Accent</strong>
          <div className="connected-folder-color-wheels">
            <span className="connected-folder-custom-color-label">Custom Color</span>
            <label className="connected-folder-color-picker" style={connectedFolderIdentityStyle(identity)}>
              <span className="connected-folder-color-wheel" aria-hidden="true">
                <span className="connected-folder-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeConnectedFolder(connectedFolderId, { color: normalizeConnectedFolderColor(event.currentTarget.value) })}
                aria-label="Choose Connected Folder Color"
              />
              <span className="connected-folder-color-value">{identity.color.toUpperCase()}</span>
            </label>
          </div>
        </div>
        <div className="connected-folder-color-controls">
          <div className="connected-folder-color-swatches" role="group" aria-label="Connected Folder color presets">
            {connectedFolderColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "connected-folder-color-swatch active" : "connected-folder-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft, "--swatch-ink": readableTextColorOn(option.color) } as CSSProperties}
                onClick={() => onCustomizeConnectedFolder(connectedFolderId, { color: option.color })}
                aria-label={`Use ${option.label} Color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                <span className="connected-folder-color-dot" aria-hidden="true">{identity.color === option.color ? <Checkmark20Regular /> : null}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
        </section>
      </div>
    </div>
  );
}

export { ConnectedFolderAppearancePanel, ConnectedFolderNameEditor };
