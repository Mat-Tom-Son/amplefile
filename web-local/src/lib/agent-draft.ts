/** A window event the main window's AmpleFile agent panel answers. */
export const ampleFileAgentDraftEvent = "amplefile:agent-draft";

export interface AmpleFileAgentDraftDetail { text: string }

/**
 * Puts a draft in front of the AmpleFile agent: in this window's agent panel
 * when it has one, otherwise in the menu-bar popover.
 */
export async function openAmpleFileAgentDraft(text: string): Promise<void> {
  const event = new CustomEvent<AmpleFileAgentDraftDetail>(ampleFileAgentDraftEvent, { detail: { text }, cancelable: true });
  // The panel cancels the event once it has taken the draft.
  if (!window.dispatchEvent(event)) return;
  const openInPopover = window.ampleFileDesktop?.agent?.openAmpleFileAgentDraft;
  if (!openInPopover) throw new Error("Open the AmpleFile agent to continue.");
  await openInPopover(text);
}
