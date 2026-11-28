import { useEffect, useId, useRef, useState } from "react";

import { api, errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { showToast } from "../../ui/feedback";
import {
  connectedFolderRoleLimits,
  connectedFolderRoleListFields,
  type ConnectedFolderRole,
  type ConnectedFolderRoleListField,
} from "../../../../src/shared/connected-folder-role";
import "./file-manager-role.css";

/** The three lists, in the order Info shows them, under their Title Case labels. */
export const roleListLabels: Record<ConnectedFolderRoleListField, string> = {
  askFor: "Ask It For",
  produces: "Produces",
  accepts: "Accepts",
};

interface Draft {
  purpose: string;
  askFor: string[];
  produces: string[];
  accepts: string[];
}

function draftOf(role: ConnectedFolderRole | null): Draft {
  return { purpose: role?.purpose ?? "", askFor: [...(role?.askFor ?? [])], produces: [...(role?.produces ?? [])], accepts: [...(role?.accepts ?? [])] };
}

export function rolePath(connectedFolderId: string): string {
  return `/api/connected-folders/${encodeURIComponent(connectedFolderId)}/role`;
}

/**
 * A Connected Folder's Role in Info (docs/product-model.md, "Roles"): what the
 * folder is for, with its Ask It For, Produces, and Accepts lists, editable in
 * place. The host owns validation and refusals; a refused Save shows the
 * host's words and keeps the draft, and nothing says Saved before the Save
 * returns. The preview shows `fixtureRole` and saves nothing.
 */
export function ConnectedFolderRoleCard({ connectedFolderId, fixtureMode, fixtureRole = null }: {
  connectedFolderId: string;
  fixtureMode: boolean;
  fixtureRole?: ConnectedFolderRole | null;
}) {
  // undefined: not read yet, so the card shows nothing rather than a flash of "No Role yet".
  const [loaded, setLoaded] = useState<{ id: string; role: ConnectedFolderRole | null } | null>(
    fixtureMode ? { id: connectedFolderId, role: fixtureRole } : null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  const purposeRef = useRef<HTMLTextAreaElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const refocusStart = useRef(false);
  const headingId = useId();
  const editing = draft !== null;
  editingRef.current = editing;

  // Another folder's card starts over; the draft belongs to the folder it was begun in.
  useEffect(() => {
    setDraft(null);
    setRefusal(null);
    setSaving(false);
    savingRef.current = false;
  }, [connectedFolderId]);

  useEffect(() => {
    if (fixtureMode) { setLoaded({ id: connectedFolderId, role: fixtureRole }); return; }
    let cancelled = false;
    const read = () => {
      void api<{ role: ConnectedFolderRole | null }>(rolePath(connectedFolderId))
        // A Worker or a verb may change the Role at any time; an edit in progress is never overwritten.
        .then(({ role }) => { if (!cancelled && !editingRef.current && !savingRef.current) setLoaded({ id: connectedFolderId, role }); })
        .catch(() => undefined);
    };
    read();
    const unsubscribe = subscribeControlEvents((hint) => { if (hint === "connected-folders" || hint === "reset") read(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [connectedFolderId, fixtureMode, fixtureRole]);

  useEffect(() => {
    if (editing) purposeRef.current?.focus();
    else if (refocusStart.current) { refocusStart.current = false; startRef.current?.focus(); }
  }, [editing]);

  if (!loaded || loaded.id !== connectedFolderId) return null;
  const role = loaded.role;

  function begin() { setRefusal(null); setDraft(draftOf(role)); }
  function cancel() { if (savingRef.current) return; refocusStart.current = true; setRefusal(null); setDraft(null); }
  function setList(field: ConnectedFolderRoleListField, next: string[]) { setDraft((current) => current && { ...current, [field]: next }); }

  async function save() {
    if (!draft || savingRef.current) return;
    if (fixtureMode) { showToast({ text: "Roles are disabled in the preview", tone: "info" }); return; }
    savingRef.current = true;
    setSaving(true);
    setRefusal(null);
    const body = {
      purpose: draft.purpose,
      askFor: draft.askFor.filter((entry) => entry.trim()),
      produces: draft.produces.filter((entry) => entry.trim()),
      accepts: draft.accepts.filter((entry) => entry.trim()),
    };
    try {
      const saved = await api<{ role: ConnectedFolderRole | null }>(rolePath(connectedFolderId), { method: "PUT", body });
      refocusStart.current = true;
      setLoaded({ id: connectedFolderId, role: saved.role });
      setDraft(null);
    } catch (caught) {
      setRefusal(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const lists = connectedFolderRoleListFields.filter((field) => role?.[field]?.length);
  return <section className="fm-sec fm-role" aria-labelledby={headingId}>
    <div className="fm-role-head">
      <h2 className="fm-sec-h" id={headingId}>Role</h2>
      {role && !editing ? <button type="button" className="fm-btn is-small" ref={startRef} onClick={begin}>Edit</button> : null}
    </div>
    {editing && draft ? <form
      className="fm-card fm-role-form"
      aria-labelledby={headingId}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel(); } }}
    >
      <label className="fm-role-label" htmlFor={`${headingId}-purpose`}>Purpose</label>
      <textarea
        id={`${headingId}-purpose`}
        ref={purposeRef}
        className="fm-role-text"
        rows={3}
        maxLength={connectedFolderRoleLimits.purpose}
        value={draft.purpose}
        placeholder="What is this folder for?"
        disabled={saving}
        aria-describedby={`${headingId}-count`}
        onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
      />
      <span className="fm-role-count" id={`${headingId}-count`}>{draft.purpose.length} of {connectedFolderRoleLimits.purpose}</span>
      {connectedFolderRoleListFields.map((field) => {
        const entries = draft[field];
        const label = roleListLabels[field];
        return <fieldset className="fm-role-list" key={field} disabled={saving}>
          <legend className="fm-role-label">{label}</legend>
          {entries.map((entry, index) => <div className="fm-role-entry" key={index}>
            <input
              type="text"
              className="fm-role-input"
              aria-label={`${label}, entry ${index + 1}`}
              maxLength={connectedFolderRoleLimits.entry}
              value={entry}
              onChange={(event) => setList(field, entries.map((item, at) => at === index ? event.target.value : item))}
            />
            <button type="button" className="fm-btn is-small" aria-label={`Remove ${label} entry ${index + 1}`} onClick={() => setList(field, entries.filter((_, at) => at !== index))}>Remove</button>
          </div>)}
          <button
            type="button"
            className="fm-btn is-small fm-role-add"
            disabled={entries.length >= connectedFolderRoleLimits.listEntries}
            aria-label={`Add ${label} Entry`}
            onClick={() => setList(field, [...entries, ""])}
          >Add Entry</button>
        </fieldset>;
      })}
      {refusal ? <p className="fm-role-refusal" role="alert">{refusal}</p> : null}
      <div className="fm-role-actions">
        <button type="button" className="fm-btn" disabled={saving} onClick={cancel}>Cancel</button>
        <button type="submit" className="fm-btn is-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </form> : role ? <div className="fm-card fm-role-view">
      {role.purpose ? <p className="fm-role-purpose">{role.purpose}</p> : null}
      {lists.map((field) => <div className="fm-role-group" key={field}>
        <h3 className="fm-role-label">{roleListLabels[field]}</h3>
        <ul>{role[field]!.map((entry) => <li key={entry}>{entry}</li>)}</ul>
      </div>)}
    </div> : <div className="fm-role-empty">
      <span className="fm-sec-empty">No Role yet. A Role says what this Connected Folder is for.</span>
      <button type="button" className="fm-btn is-small" ref={startRef} onClick={begin}>Add Role</button>
    </div>}
  </section>;
}
