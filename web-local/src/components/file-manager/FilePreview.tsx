import { useEffect, useState } from "react";
import { Dismiss16Regular } from "@fluentui/react-icons";

import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { rawFileObjectUrlAt } from "../../lib/raw-file";
import type { TreeEntry } from "../../types";
import { fileKindLabel, fileManagerIcon } from "./file-manager-model";
import { filePreviewNotice, filePreviewPdfParameters, filePreviewTextLimitLabel, fixtureFilePreview, type FilePreviewContent } from "./file-preview-model";
import "./file-manager-preview.css";

/**
 * The file list's Preview, drawn by the window where the desktop has no Quick
 * Look (docs/product-model.md, the file manager window). It shows the item the
 * list has selected, so the arrow keys move it; Space or Esc in the list, or
 * Close, puts it away. The list keeps the keyboard.
 *
 * File content is untrusted: text is shown as text, an image through an
 * `<img>` (an SVG's scripts and remote references never run there), and a PDF
 * in the built-in viewer from a `blob:` URL of its own bytes; the window's
 * content policy allows no remote loads. The host bounds every read and keeps
 * it inside the place, with the same path policy as every other route.
 *
 * Mount it with a `key` per item, so each item starts from nothing.
 */
export function FilePreview({ apiBase, entry, fixtureText, fixtureMode, onOpen, onClose }: {
  /** The place's API base (a Connected Folder's or a standard folder's). */
  apiBase: string;
  entry: TreeEntry;
  /** In the sample window: the sample's text for this file, if it has any. */
  fixtureText?: string;
  fixtureMode: boolean;
  onOpen: (() => void) | null;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<FilePreviewContent | null>(null);
  const [failed, setFailed] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (entry.kind !== "file") return;
    if (fixtureMode) { setPreview(fixtureFilePreview(fixtureText)); return; }
    const controller = new AbortController();
    let created: string | null = null;
    void (async () => {
      try {
        const result = await api<{ preview: FilePreviewContent }>(`${apiBase}/file-preview?path=${encodeURIComponent(entry.path)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPreview(result.preview);
        if (result.preview.kind !== "image" && result.preview.kind !== "pdf") return;
        const url = await rawFileObjectUrlAt(apiBase, entry.path, controller.signal);
        if (controller.signal.aborted) { URL.revokeObjectURL(url); return; }
        created = url;
        setObjectUrl(url);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [apiBase, entry.kind, entry.path, fixtureMode, fixtureText]);

  const notice = filePreviewNotice(entry, preview, failed);
  const icon = fileManagerIcon(entry);
  const size = preview?.sizeBytes ?? entry.sizeBytes;
  const meta = entry.kind === "folder" ? "Folder" : `${fileKindLabel(entry)}${typeof size === "number" ? ` · ${formatBytes(size)}` : ""}`;
  const text = !failed && preview?.kind === "text" && preview.content ? preview : null;
  const media = !failed && objectUrl && (preview?.kind === "image" || preview?.kind === "pdf") ? preview.kind : null;
  const waiting = entry.kind === "file" && !failed && !notice && !text && !media;
  return <div
    className="fm-preview"
    role="dialog"
    aria-label={`Preview of ${entry.name}`}
    onKeyDown={(event) => {
      // With the keyboard on Close or Open, Esc still puts the Preview away.
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}
  >
    <div className="fm-preview-bar">
      <span className="fm-preview-name" title={entry.name}>{entry.name}</span>
      {onOpen && entry.kind === "file" ? <button type="button" className="fm-btn is-small" onClick={onOpen}>Open</button> : null}
      <button type="button" className="fm-capbtn fm-preview-close" aria-label="Close Preview" title="Close Preview" onClick={onClose}><Dismiss16Regular /></button>
    </div>
    <div className={`fm-preview-body${text ? " is-text" : media ? ` is-${media}` : " is-card"}`}>
      {text ? <>
        <pre className="fm-preview-text">{text.content}</pre>
        {text.truncated ? <p className="fm-preview-note">Preview stops at {filePreviewTextLimitLabel}.</p> : null}
      </> : media === "image" ? <img className="fm-preview-image" src={objectUrl!} alt={entry.name} draggable={false} />
        : media === "pdf" ? <iframe className="fm-preview-pdf" title={entry.name} src={`${objectUrl}${filePreviewPdfParameters}`} />
        : <div className="fm-preview-card">
          <span className="fm-preview-icon"><span className={icon.className} data-label={icon.label} aria-hidden="true" /></span>
          <span className="fm-preview-card-name" title={entry.name}>{entry.name}</span>
          <span className="fm-preview-card-meta">{meta}</span>
          {notice ? <span className="fm-preview-card-note">{notice}</span> : waiting ? <span className="fm-preview-card-note" aria-live="polite">Loading…</span> : null}
        </div>}
    </div>
  </div>;
}
