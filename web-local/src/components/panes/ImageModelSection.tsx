import { useState } from "react";

import { api, errorText } from "../../lib/api";
import type { AgentModel } from "../../types";
import { ModelCatalogList, modelCatalogKey, modelDisplayName } from "./ModelCatalogList";

interface ImageModelSummary { provider: string; providerName: string; id: string; name: string }
export interface ImageModelSettings {
  selected: { provider: string; id: string } | null;
  /** False when the saved model's provider is disconnected; Automatic is used until it returns. */
  selectedAvailable: boolean;
  automatic: ImageModelSummary | null;
  models: ImageModelSummary[];
}

/** The list's own entry for Automatic, kept apart from any real provider id. */
const automaticEntry = { provider: "amplefile", id: "automatic" };

/**
 * Settings → AI Models → Image model: one machine-wide choice for
 * every Worker and the AmpleFile Agent, saved as soon as it is picked. Its
 * data arrives with the AI Models load, so opening Settings costs no extra request.
 * Automatic follows AmpleFile's own preference among connected image models.
 */
export function ImageModelSection({ settings, onChange }: {
  settings: ImageModelSettings;
  onChange: (settings: ImageModelSettings) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function choose(key: string) {
    if (saving) return;
    const picked = key === modelCatalogKey(automaticEntry)
      ? null
      : settings.models.find((item) => modelCatalogKey(item) === key);
    if (picked === undefined) return;
    setSaving(true);
    setError(null);
    try {
      onChange(await api<ImageModelSettings>("/api/agent/image-model", {
        method: "POST",
        body: { model: picked ? { provider: picked.provider, id: picked.id } : null },
      }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  // Shown as the model Automatic would pick right now, tagged Automatic.
  const automaticName = settings.automatic ? modelDisplayName(settings.automatic) : "Automatic";
  const entries = [{ ...automaticEntry, name: automaticName, providerName: "Automatic" }, ...settings.models] as AgentModel[];
  const value = settings.selected && settings.selectedAvailable ? modelCatalogKey(settings.selected) : modelCatalogKey(automaticEntry);

  return (
    <section className="ai-models-settings-section ai-models-image-section" aria-labelledby="image-model-heading">
      <div className="ai-models-section-heading">
        <h3 id="image-model-heading">Image Model</h3>
        <span className="ai-models-section-meta">Shared</span>
      </div>
      <div className="ai-models-row ai-models-model-row">
        <span className="ai-models-row-title" id="image-model-label">Default</span>
        <div className="ai-models-model-picker">
          <ModelCatalogList id="image-model" labelledBy="image-model-label" models={entries} value={value} groupByProvider disabled={saving} onChange={(key) => { void choose(key); }} />
        </div>
      </div>
      {!settings.models.length ? <p className="ai-models-row-note">Connect a provider with image models to generate pictures.</p> : null}
      {settings.selected && !settings.selectedAvailable ? <p className="ai-models-row-note">Using Automatic until the chosen provider reconnects.</p> : null}
      {error ? <p className="ai-models-row-note error" role="alert">{error}</p> : null}
    </section>
  );
}
