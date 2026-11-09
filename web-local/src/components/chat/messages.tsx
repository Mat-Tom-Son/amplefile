import { Children, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Checkmark20Regular, Copy20Regular, Sparkle20Regular } from "@fluentui/react-icons";

import { copyToClipboard } from "../../lib/clipboard";
import { requestConnectAi } from "../../lib/connect-ai";
import { formatDateTime } from "../../lib/format";
import { resolveMessageImageSource } from "../../lib/message-images";
import { assistantTurnView, savedWorkTrailPreviews } from "../../lib/chat-work-trail";
import { rehypeSingleLineBreaks } from "../../lib/markdown-line-breaks";
import { collectConnectedFolderPathCandidates, findConnectedFolderPathMentions, connectedFolderPathCandidate } from "../../lib/connected-folder-path-links";
import type { ChatMessage, ChatMessageLanding, RuntimePreviewEntry } from "../../types";
import { FluentGlyph } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTypeIcon";
import { RuntimeContextPreview, turnChangedFiles, type TurnChangedFile, type ConnectedFolderPathLinkResolver } from "./activity";
import { GeneratedImages, turnGeneratedImages } from "./GeneratedImages";
import { SafeMarkdownAnchor } from "./SafeMarkdownAnchor";

export type { ConnectedFolderPathLinkResolver };

const assistantMessageConnectedFolderPathCache = new Map<string, {
  content: string;
  resolved: Map<string, string>;
  promise: Promise<Map<string, string>> | null;
}>();

interface ChatMessageRowProps {
  message: ChatMessage;
  copied: boolean;
  showLanding: boolean;
  suppressEnterAnimation: boolean;
  showRuntimePreview: boolean;
  runtimePreviews: RuntimePreviewEntry[];
  connectedFolderId: string;
  connectedFolderRoot: string;
  onOpenConnectedFolderFile?: (path: string) => void;
  resolveConnectedFolderPathLinks?: ConnectedFolderPathLinkResolver;
  onCopyMessage: (messageId: string, content: string) => void | Promise<void>;
  /** Present only on the Chat's last message while nothing runs: an interrupted reply can be continued. */
  onContinue?: () => void;
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  copied,
  showLanding,
  suppressEnterAnimation,
  showRuntimePreview,
  runtimePreviews,
  connectedFolderId,
  connectedFolderRoot,
  onOpenConnectedFolderFile,
  resolveConnectedFolderPathLinks,
  onCopyMessage,
  onContinue,
}: ChatMessageRowProps) {
  const connectedFolderLinkCacheKey = `${connectedFolderId}:${message.id}`;
  // Links resolved for this exact reply text. Kept in state, so resolving
  // them re-renders only the linked text instead of remounting the reply.
  const [resolvedLinks, setResolvedLinks] = useState<{ cacheKey: string; content: string; links: Map<string, string> } | null>(null);
  const cachedConnectedFolderLinks = assistantMessageConnectedFolderPathCache.get(connectedFolderLinkCacheKey);
  const connectedFolderLinks = resolvedLinks?.cacheKey === connectedFolderLinkCacheKey && resolvedLinks.content === message.content
    ? resolvedLinks.links
    : cachedConnectedFolderLinks?.content === message.content && cachedConnectedFolderLinks.resolved.size ? cachedConnectedFolderLinks.resolved : null;
  const messageTime = message.createdAt ? formatDateTime(message.createdAt) : "";
  const savedRuntimePreviews = savedWorkTrailPreviews(message);
  const visibleRuntimePreviews = showRuntimePreview && runtimePreviews.length
    ? runtimePreviews
    : savedRuntimePreviews;
  const turnView = assistantTurnView(message.content, message.role === "assistant" ? message.assistantPresentation : undefined, visibleRuntimePreviews);
  const generatedImages = message.role === "assistant" ? turnGeneratedImages(visibleRuntimePreviews) : [];
  const changedFiles = message.role === "assistant" && onOpenConnectedFolderFile && resolveConnectedFolderPathLinks
    ? turnChangedFiles(visibleRuntimePreviews, connectedFolderRoot)
    : [];

  const opensFiles = Boolean(onOpenConnectedFolderFile);
  useEffect(() => {
    if (message.role !== "assistant" || !resolveConnectedFolderPathLinks || !opensFiles) return;
    const candidates = collectConnectedFolderPathCandidates(message.content);
    if (!candidates.length) return;
    let cancelled = false;
    const content = message.content;
    void resolveMessageConnectedFolderLinks(connectedFolderLinkCacheKey, content, candidates, resolveConnectedFolderPathLinks)
      .then((links) => {
        if (cancelled) return;
        setResolvedLinks((current) => current?.cacheKey === connectedFolderLinkCacheKey && current.content === content && sameLinks(current.links, links)
          ? current
          : { cacheKey: connectedFolderLinkCacheKey, content, links });
      });
    return () => {
      cancelled = true;
    };
  }, [message.content, message.id, message.role, opensFiles, resolveConnectedFolderPathLinks, connectedFolderLinkCacheKey]);

  if (message.kind === "assistant_continuation") return <p className="work-continuation" role="note">Continuing with the results from delegated work.</p>;
  if (message.kind === "context_compaction") return <p className="work-continuation" role="note">{message.content}</p>;

  return (
    <article className={`message ${message.role}${suppressEnterAnimation ? " settled" : ""}`}>
      {message.role === "user" && message.attachments?.length ? <SentAttachments attachments={message.attachments} onOpenConnectedFolderFile={onOpenConnectedFolderFile} /> : null}
      <div className="message-surface">
        {turnView.steps.length ? (
          <RuntimeContextPreview
            entries={turnView.steps}
            connectedFolderRoot={connectedFolderRoot}
            onOpenConnectedFolderFile={message.role === "assistant" ? onOpenConnectedFolderFile : undefined}
            resolveConnectedFolderPathLinks={message.role === "assistant" ? resolveConnectedFolderPathLinks : undefined}
            renderText={(content, links) => <MarkdownMessage content={content} connectedFolderLinks={links} onOpenConnectedFolderFile={onOpenConnectedFolderFile} />}
          />
        ) : null}
        {turnView.answer ? <MarkdownMessage
          content={turnView.answer}
          connectedFolderLinks={message.role === "assistant" ? connectedFolderLinks : null}
          onOpenConnectedFolderFile={message.role === "assistant" ? onOpenConnectedFolderFile : undefined}
        /> : null}
        {generatedImages.length ? <GeneratedImages images={generatedImages} connectedFolderId={connectedFolderId} onOpenConnectedFolderFile={onOpenConnectedFolderFile} /> : null}
        {changedFiles.length && onOpenConnectedFolderFile && resolveConnectedFolderPathLinks
          ? <TurnFiles files={changedFiles} resolveConnectedFolderPathLinks={resolveConnectedFolderPathLinks} onOpenConnectedFolderFile={onOpenConnectedFolderFile} />
          : null}
        {message.role === "assistant" && showLanding && message.landing ? <TurnLanding landing={message.landing} /> : null}
        {message.role === "assistant" && message.interruption ? <InterruptedTurn interruption={message.interruption} onContinue={onContinue} /> : null}
      </div>
      <footer className="message-footer">
        <span className="message-footer-meta">
          <MessageActions
            copied={copied}
            onCopy={() => void onCopyMessage(message.id, message.content)}
          />
          {message.createdAt && messageTime ? (
            <time className="message-time" dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
              {messageTime}
            </time>
          ) : null}
          {message.role === "user" && message.delivery === "steer" ? (
            <span className="message-delivery" title="Sent while the Worker was working; it applied after the step in progress.">Sent Mid-Turn</span>
          ) : null}
        </span>
      </footer>
    </article>
  );
}, areChatMessageRowPropsEqual);

function areChatMessageRowPropsEqual(previous: ChatMessageRowProps, next: ChatMessageRowProps): boolean {
  const previousMessage = previous.message;
  const nextMessage = next.message;
  const sameMessage = previousMessage === nextMessage || (
    previousMessage.id === nextMessage.id
    && previousMessage.role === nextMessage.role
    && previousMessage.content === nextMessage.content
    && previousMessage.createdAt === nextMessage.createdAt
    && previousMessage.kind === nextMessage.kind
    && previousMessage.landing === nextMessage.landing
    && previousMessage.workTrail === nextMessage.workTrail
    && previousMessage.assistantPresentation === nextMessage.assistantPresentation
    && previousMessage.interruption === nextMessage.interruption
    && previousMessage.attachments === nextMessage.attachments
    && previousMessage.delivery === nextMessage.delivery
  );
  const sameRuntimePreview = !previous.showRuntimePreview && !next.showRuntimePreview
    ? true
    : previous.runtimePreviews === next.runtimePreviews;
  return sameMessage
    && previous.copied === next.copied
    && previous.showLanding === next.showLanding
    && previous.suppressEnterAnimation === next.suppressEnterAnimation
    && previous.showRuntimePreview === next.showRuntimePreview
    && sameRuntimePreview
    && previous.connectedFolderId === next.connectedFolderId
    && previous.connectedFolderRoot === next.connectedFolderRoot
    && previous.onOpenConnectedFolderFile === next.onOpenConnectedFolderFile
    && previous.resolveConnectedFolderPathLinks === next.resolveConnectedFolderPathLinks
    && previous.onCopyMessage === next.onCopyMessage
    && previous.onContinue === next.onContinue;
}

/** How many changed files a reply lists before "Show all". */
const turnFilesShownAtFirst = 5;

/**
 * The files a reply wrote or edited, listed at its end so the result is one
 * click away. A file that no longer exists is left out.
 */
function TurnFiles({ files, resolveConnectedFolderPathLinks, onOpenConnectedFolderFile }: {
  files: TurnChangedFile[];
  resolveConnectedFolderPathLinks: ConnectedFolderPathLinkResolver;
  onOpenConnectedFolderFile: (path: string) => void;
}) {
  const key = files.map((file) => file.path).join("\n");
  const [existing, setExisting] = useState<Map<string, string> | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void resolveConnectedFolderPathLinks(key.split("\n"))
      .then((resolved) => { if (!cancelled) setExisting(resolved); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [key, resolveConnectedFolderPathLinks]);
  if (!existing) return null;
  const present = files.flatMap((file) => {
    const path = existing.get(file.path);
    return path ? [{ ...file, path }] : [];
  });
  if (!present.length) return null;
  const shown = showAll ? present : present.slice(0, turnFilesShownAtFirst);
  return (
    <ul className="turn-files" aria-label="Files from this reply">
      {shown.map((file) => {
        const slash = file.path.lastIndexOf("/");
        const folder = slash > 0 ? file.path.slice(0, slash) : "";
        return (
          <li key={file.path}>
            <button type="button" onClick={() => onOpenConnectedFolderFile(file.path)} title={file.path}>
              <FileTypeIcon path={file.path} />
              <span className="turn-file-copy">
                <span className="turn-file-name">{slash >= 0 ? file.path.slice(slash + 1) : file.path}</span>
                <span className="turn-file-detail">{file.change === "saved" ? "Saved" : "Edited"}{folder ? ` · ${folder}` : ""}</span>
              </span>
              <span className="turn-file-open" aria-hidden="true">Open</span>
            </button>
          </li>
        );
      })}
      {present.length > shown.length ? (
        <li>
          <button className="turn-files-more" type="button" onClick={() => setShowAll(true)}>Show All {present.length} Files</button>
        </li>
      ) : null}
    </ul>
  );
}

/** The files that went out with a message, drawn like the composer's chips; each opens its file. */
function SentAttachments({ attachments, onOpenConnectedFolderFile }: {
  attachments: NonNullable<ChatMessage["attachments"]>;
  onOpenConnectedFolderFile?: (path: string) => void;
}) {
  return (
    <ul className="message-attachments" aria-label="Attached files">
      {attachments.map((attachment) => {
        const content = <span className="context-chip-main"><FileTypeIcon path={attachment.target} /><span className="context-chip-name">{attachment.name}</span></span>;
        return (
          <li key={`${attachment.kind}:${attachment.target}`}>
            {onOpenConnectedFolderFile && attachment.kind === "file"
              ? <button className="context-chip message-attachment" type="button" title={attachment.target} onClick={() => onOpenConnectedFolderFile(attachment.target)}>{content}</button>
              : <span className="context-chip message-attachment" title={attachment.target}>{content}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function MessageActions({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <div className="message-actions">
      <button
        className={copied ? "message-copy-button is-copied" : "message-copy-button"}
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied Message" : "Copy Message"}
        title={copied ? "Copied" : "Copy Message"}
      >
        {copied ? <FluentGlyph icon={Checkmark20Regular} size={14} /> : <FluentGlyph icon={Copy20Regular} size={14} />}
      </button>
    </div>
  );
}

export function TurnLanding({ landing }: { landing: ChatMessageLanding }) {
  return (
    <section className="turn-landing" aria-label="Turn Summary">
      <div className="turn-landing-heading">
        <span>
          <FluentGlyph icon={Sparkle20Regular} size={15} />
          Turn Summary
        </span>
      </div>
      <p>{landing.summary}</p>
      {landing.nextActions.length ? (
        <ul>
          {landing.nextActions.map((action) => <li key={action}>{action}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

/** The message a Continue click sends: the person's own words, shown in the Chat like any message. */
export const continueInterruptedTurnMessage = "Continue where you left off.";

function ContinueButton({ onContinue }: { onContinue?: () => void }) {
  if (!onContinue) return null;
  return <button className="ui-control turn-interruption-continue" type="button" onClick={onContinue}>Continue</button>;
}

function InterruptedTurn({ interruption, onContinue }: { interruption: NonNullable<ChatMessage["interruption"]>; onContinue?: () => void }) {
  if (interruption.reason === "setup_error") {
    return (
      <section className="turn-interruption turn-interruption--setup" role="status" aria-label="Worker setup needed">
        <strong>Connect Your AI to Continue</strong>
        <span>Sign in with ChatGPT, Claude, or OpenRouter, or paste an API key.</span>
        <button className="ui-control ui-control--primary" type="button" onClick={() => requestConnectAi()}>Connect AI</button>
      </section>
    );
  }
  if (interruption.reason === "assistant_error") {
    return (
      <section className="turn-interruption" role="status" aria-label="Failed Worker response">
        <strong>Request Stopped</strong>
        <span>AmpleFile saved this result with your Chat. You can try again whenever you’re ready.</span>
        <ContinueButton onContinue={onContinue} />
      </section>
    );
  }
  if (interruption.reason === "cancelled") {
    return (
      <section className="turn-interruption" role="status" aria-label="Stopped Worker response">
        <strong>Response Stopped</strong>
        <span>AmpleFile saved the response produced before you stopped the Worker.</span>
      </section>
    );
  }
  if (interruption.reason === "app_interrupted") {
    return (
      <section className="turn-interruption" role="status" aria-label="Worker response interrupted by app close">
        <strong>App Interrupted This Response</strong>
        <span>AmpleFile saved the partial response and did not rerun the turn because tools may already have changed something.</span>
        <ContinueButton onContinue={onContinue} />
      </section>
    );
  }
  const retryText = interruption.retryAttempts > 0
    ? interruption.retryAttempts === 1 ? "1 automatic retry was attempted." : `${interruption.retryAttempts} automatic retries were attempted.`
    : "The provider did not identify this as safely retryable.";
  return (
    <section className="turn-interruption" role="status" aria-label="Interrupted Worker response">
      <strong>Response Interrupted</strong>
      <span>AmpleFile preserved the partial response. {retryText}</span>
      <ContinueButton onContinue={onContinue} />
    </section>
  );
}

interface MarkdownLinkTargets {
  connectedFolderLinks: Map<string, string> | null;
  onOpenConnectedFolderFile?: (path: string) => void;
}

const MarkdownLinkContext = createContext<MarkdownLinkTargets>({ connectedFolderLinks: null });
const markdownRemarkPlugins = [remarkGfm];
const markdownRehypePlugins = [rehypeSingleLineBreaks];

function useLinkedChildren(children: ReactNode): ReactNode {
  const { connectedFolderLinks, onOpenConnectedFolderFile } = useContext(MarkdownLinkContext);
  return linkConnectedFolderPathText(children, connectedFolderLinks, onOpenConnectedFolderFile);
}

// Element renderers are module-level so their identity never changes: a new
// function per render would make React replace every element of every reply
// (losing text selection) each time a Chat re-renders. Links come from context.
const markdownComponents: Components = {
  p: function MarkdownParagraph({ children }) { return <p>{useLinkedChildren(children)}</p>; },
  li: function MarkdownListItem({ children, className }) { return <li className={className}>{useLinkedChildren(children)}</li>; },
  td: function MarkdownCell({ children }) { return <td>{useLinkedChildren(children)}</td>; },
  th: function MarkdownHeaderCell({ children }) { return <th>{useLinkedChildren(children)}</th>; },
  table: ({ children }) => <div className="message-table-scroll"><table>{children}</table></div>,
  pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
  code: function MarkdownCode({ children, className }) {
    const { connectedFolderLinks, onOpenConnectedFolderFile } = useContext(MarkdownLinkContext);
    const text = reactNodeText(children);
    if (className || text.includes("\n")) return <code className={className}>{children}</code>;
    const normalizedPath = connectedFolderPathCandidate(text, { allowConnectedFolders: true });
    const resolvedPath = normalizedPath ? connectedFolderLinks?.get(normalizedPath) ?? null : null;
    if (!resolvedPath || !onOpenConnectedFolderFile) return <code>{children}</code>;
    return (
      <button
        className="connected-folder-file-link connected-folder-file-link-code"
        type="button"
        onClick={() => onOpenConnectedFolderFile(resolvedPath)}
        title={resolvedPath}
      >
        {text}
      </button>
    );
  },
  a: function MarkdownLink({ href, children }) {
    const { connectedFolderLinks, onOpenConnectedFolderFile } = useContext(MarkdownLinkContext);
    const connectedFolderPath = connectedFolderPathCandidate(href ?? "", { allowConnectedFolders: true });
    const resolvedPath = connectedFolderPath ? connectedFolderLinks?.get(connectedFolderPath) ?? null : null;
    if (resolvedPath && onOpenConnectedFolderFile) {
      return <button className="connected-folder-file-link" type="button" onClick={() => onOpenConnectedFolderFile(resolvedPath)} title={resolvedPath}>{children}</button>;
    }
    return <SafeMarkdownAnchor href={href}>{children}</SafeMarkdownAnchor>;
  },
  img: function MarkdownImage({ src, alt }) {
    const { connectedFolderLinks, onOpenConnectedFolderFile } = useContext(MarkdownLinkContext);
    const source = typeof src === "string" ? src : "";
    const connectedFolderPath = connectedFolderPathCandidate(source, { allowConnectedFolders: true });
    const resolvedPath = connectedFolderPath ? connectedFolderLinks?.get(connectedFolderPath) ?? null : null;
    if (resolvedPath && onOpenConnectedFolderFile) {
      return <button className="message-image-file" type="button" onClick={() => onOpenConnectedFolderFile(resolvedPath)} title={resolvedPath}>{alt || resolvedPath.split("/").pop() || "Open Image"}</button>;
    }
    const resolution = resolveMessageImageSource(source, window.location.href);
    if (resolution.kind === "embed") return <img className="message-image" src={resolution.src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
    if (resolution.kind === "external-link") {
      return <a className="message-image-external" href={resolution.href} target="_blank" rel="noreferrer">{alt ? `Open Image: ${alt}` : "Open External Image"}</a>;
    }
    return <span className="message-image-unavailable">{alt ? `${alt} (image unavailable)` : "Image Unavailable"}</span>;
  },
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  connectedFolderLinks = null,
  onOpenConnectedFolderFile,
}: {
  content: string;
  connectedFolderLinks?: Map<string, string> | null;
  onOpenConnectedFolderFile?: (path: string) => void;
}) {
  const links = useMemo<MarkdownLinkTargets>(() => ({ connectedFolderLinks, onOpenConnectedFolderFile }), [connectedFolderLinks, onOpenConnectedFolderFile]);
  return (
    <div className="message-body">
      <MarkdownLinkContext.Provider value={links}>
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </MarkdownLinkContext.Provider>
    </div>
  );
});

function sameLinks(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = reactNodeText(children).replace(/\n$/, "");
  const codeElement = Children.toArray(children).find((child) => isValidElement(child)) as ReactElement<{ className?: string }> | undefined;
  const language = codeElement?.props.className?.match(/(?:^|\s)language-([\w-]+)/)?.[1] ?? "";
  const label = language ? codeLanguageName(language) : "Code";
  // Prose wraps; code keeps its lines.
  const wraps = /^(text|txt|plaintext|md|markdown)$/i.test(language);

  async function copyCode() {
    try {
      await copyToClipboard({ text });
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`message-code-block${wraps ? " wraps" : ""}`}>
      <div className="message-code-toolbar">
        <span>{label}</span>
        <button className={copied ? "is-copied" : undefined} type="button" onClick={() => void copyCode()} aria-label={copied ? "Copied Code" : "Copy Code"} title={copied ? "Copied" : "Copy Code"}>
          <FluentGlyph icon={copied ? Checkmark20Regular : Copy20Regular} size={13} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

async function resolveMessageConnectedFolderLinks(
  cacheKey: string,
  content: string,
  candidates: string[],
  resolver: ConnectedFolderPathLinkResolver,
): Promise<Map<string, string>> {
  const cached = assistantMessageConnectedFolderPathCache.get(cacheKey);
  if (cached?.content === content) {
    if (cached.promise) return cached.promise;
    return cached.resolved;
  }
  const promise = resolver(candidates)
    .then((resolved) => {
      // Empty results are not cached: the tree (fixture mode) or the API may simply
      // not be ready yet, and a poisoned empty entry would never be retried.
      if (resolved.size) assistantMessageConnectedFolderPathCache.set(cacheKey, { content, resolved, promise: null });
      else assistantMessageConnectedFolderPathCache.delete(cacheKey);
      return resolved;
    })
    .catch(() => {
      assistantMessageConnectedFolderPathCache.delete(cacheKey);
      return new Map<string, string>();
    });
  assistantMessageConnectedFolderPathCache.set(cacheKey, { content, resolved: new Map(), promise });
  return promise;
}

function linkConnectedFolderPathText(
  children: ReactNode,
  connectedFolderLinks: Map<string, string> | null | undefined,
  onOpenConnectedFolderFile: ((path: string) => void) | undefined,
): ReactNode {
  if (!connectedFolderLinks?.size || !onOpenConnectedFolderFile) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return linkConnectedFolderPathString(child, connectedFolderLinks, onOpenConnectedFolderFile);
    if (!isValidElement(child) || child.type === "a" || child.type === "code" || child.type === "button") return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, undefined, linkConnectedFolderPathText(element.props.children, connectedFolderLinks, onOpenConnectedFolderFile));
  });
}

function linkConnectedFolderPathString(
  text: string,
  connectedFolderLinks: Map<string, string>,
  onOpenConnectedFolderFile: (path: string) => void,
): ReactNode {
  const mentions = findConnectedFolderPathMentions(text).filter((mention) => connectedFolderLinks.has(mention.normalizedPath));
  if (!mentions.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    const resolvedPath = connectedFolderLinks.get(mention.normalizedPath);
    if (!resolvedPath) return;
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(
      <button
        className="connected-folder-file-link"
        type="button"
        onClick={() => onOpenConnectedFolderFile(resolvedPath)}
        title={resolvedPath}
        key={`${mention.start}:${mention.normalizedPath}:${index}`}
      >
        {mention.text}
      </button>,
    );
    cursor = mention.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function reactNodeText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement(child)) return "";
    return reactNodeText((child as ReactElement<{ children?: ReactNode }>).props.children);
  }).join("");
}

export async function copyMarkdownToClipboard(content: string): Promise<void> {
  await copyToClipboard({ text: content, html: markdownToClipboardHtml(content) });
}

function markdownToClipboardHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/).filter((block) => block.trim());
  const html = blocks.map((block) => {
    const trimmed = block.trim();
    const codeFence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (codeFence) return `<pre><code>${escapeHtml(codeFence[1] ?? "")}</code></pre>`;
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1);
      return `<h${level}>${inlineMarkdownToHtml(heading[2] ?? "")}</h${level}>`;
    }
    const lines = trimmed.split(/\r?\n/);
    if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
      return `<ul>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.trim().replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    if (lines.every((line) => /^\d+[.)]\s+/.test(line.trim()))) {
      return `<ol>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.trim().replace(/^\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    }
    return `<p>${inlineMarkdownToHtml(lines.join("\n"))}</p>`;
  }).join("");
  return `<div>${html}</div>`;
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const codeLanguageNames: Record<string, string> = {
  text: "Plain Text", txt: "Plain Text", plaintext: "Plain Text", md: "Markdown", markdown: "Markdown",
  js: "JavaScript", jsx: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python",
  sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell", console: "Shell", ps1: "PowerShell", powershell: "PowerShell",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", html: "HTML", css: "CSS", scss: "SCSS",
  sql: "SQL", csv: "CSV", diff: "Diff", go: "Go", rs: "Rust", rust: "Rust", rb: "Ruby", ruby: "Ruby", java: "Java",
  kt: "Kotlin", swift: "Swift", c: "C", cpp: "C++", cs: "C#", php: "PHP", r: "R",
};

/** A code block's language as people name it ("Python", "Plain Text"), not shouted in capitals. */
export function codeLanguageName(language: string): string {
  const key = language.trim().toLowerCase();
  return codeLanguageNames[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
