import type { TreeEntry } from "../../types";

/**
 * What the place's `file-preview` route answers (src/local/connected-folder.ts,
 * getConnectedFolderFilePreview): the host decides the kind and the bounds.
 * Text arrives as a bounded head read; an image or a PDF is then read through
 * the same place's `raw-file` route; anything else is `none` with its reason.
 */
export interface FilePreviewContent {
  kind: "text" | "image" | "pdf" | "none";
  reason?: "folder" | "binary" | "too-large";
  content?: string;
  truncated?: boolean;
  sizeBytes: number;
}

/** How much text the host reads for a preview; the note under a truncated one says so. */
export const filePreviewTextLimitLabel = "256 KB";

/**
 * The built-in PDF viewer's fragment: no toolbar or side panes, page width.
 * The viewer draws a PDF from a `blob:` URL of the file's own bytes.
 */
export const filePreviewPdfParameters = "#toolbar=0&navpanes=0&view=FitH";

/**
 * Space in the file list where the window draws its own Preview (every desktop
 * but the Mac, where Space asks Quick Look): it closes an open Preview, and
 * opens one only on a selected file, as Quick Look does.
 */
export function previewSpaceAction(open: boolean, focused: Pick<TreeEntry, "kind"> | null): "open" | "close" | null {
  if (open) return "close";
  return focused?.kind === "file" ? "open" : null;
}

/** The sample window has no host: a sample file with text shows it, and any other shows its card. */
export function fixtureFilePreview(text: string | undefined): FilePreviewContent {
  if (text === undefined) return { kind: "none", reason: "binary", sizeBytes: 0 };
  return { kind: "text", content: text, truncated: false, sizeBytes: new TextEncoder().encode(text).length };
}

/**
 * The line under the card when the Preview cannot show the file itself, or
 * null when it shows it (or is still reading it).
 */
export function filePreviewNotice(entry: Pick<TreeEntry, "kind">, preview: FilePreviewContent | null, failed: boolean): string | null {
  if (entry.kind === "folder") return null;
  if (failed) return "This file can’t be previewed.";
  if (!preview) return null;
  if (preview.kind === "none") return preview.reason === "too-large" ? "This file is too large to preview." : "There’s no preview for this kind of file.";
  if (preview.kind === "text" && !preview.content) return "This file is empty.";
  return null;
}
