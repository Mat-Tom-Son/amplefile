import { useEffect, useState } from "react";
import { ArrowClockwise20Regular, Checkmark16Regular } from "@fluentui/react-icons";

import {
  fileManagerSettingsCopy as copy,
  isLinuxFileManagerStatus,
  linuxFileManagerSettingsView,
  type LinuxFileManagerStatus,
} from "../../../../src/shared/linux-file-manager-settings";
import { errorText } from "../../lib/api";
import { showToast } from "../../ui/feedback";

type Part = "showFilesFromOtherApps" | "openFoldersByDefault";

function readStatus(value: unknown): LinuxFileManagerStatus {
  if (!isLinuxFileManagerStatus(value)) throw new Error("AmpleFile couldn't read the file manager settings.");
  return value;
}

function plainError(caught: unknown): string {
  return errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

/**
 * Settings → File Manager (Linux): two independent choices, each showing
 * what the system says now and turned off from the same place.
 */
export function FileManagerPane() {
  const bridge = window.ampleFileDesktop?.fileManagerIntegration;
  const [status, setStatus] = useState<LinuxFileManagerStatus | null>(null);
  const [busy, setBusy] = useState<Part | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Part, string>>>({});

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const load = () => bridge.status().then(
      (next) => { if (!cancelled) setStatus(readStatus(next)); },
      (caught: unknown) => { if (!cancelled) setErrors({ showFilesFromOtherApps: plainError(caught) }); },
    );
    void load();
    // Another file manager may let go of the name while Settings is open.
    const interval = window.setInterval(() => { void load(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [bridge]);

  if (!bridge) return null;

  async function change(part: Part, enabled: boolean) {
    if (!bridge || busy) return;
    setBusy(part);
    setErrors((current) => ({ ...current, [part]: undefined }));
    try {
      const next = readStatus(part === "showFilesFromOtherApps" ? await bridge.setShowFilesFromOtherApps(enabled) : await bridge.setOpenFoldersByDefault(enabled));
      setStatus(next);
      showToast({ text: `${copy[part].label}: ${enabled ? "on" : "off"}`, tone: "success" });
    } catch (caught) {
      setErrors((current) => ({ ...current, [part]: plainError(caught) }));
      void bridge.status().then((next) => setStatus(readStatus(next)), () => undefined);
    } finally {
      setBusy(null);
    }
  }

  const view = status ? linuxFileManagerSettingsView(status) : null;
  const parts: Part[] = ["showFilesFromOtherApps", "openFoldersByDefault"];
  return (
    <div className="command-line-pane file-manager-pane">
      <p className="command-line-intro">{copy.intro}</p>
      <section className="settings-section" aria-labelledby="file-manager-other-apps">
        <div className="settings-section-heading"><h3 id="file-manager-other-apps">Other Apps</h3></div>
        <div className="settings-list">
          {parts.map((part) => {
            const row = view?.[part];
            const error = errors[part];
            return (
              <div className="settings-list-row" key={part}>
                <div>
                  <strong id={`file-manager-${part}`}>{copy[part].label}</strong>
                  <small>{copy[part].description}</small>
                  {row ? <small className={row.tone === "warning" ? "settings-inline-error" : undefined}>{row.detail}</small> : null}
                  {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
                </div>
                <div className="settings-actions">
                  <span className={`command-line-state${row?.checked ? " is-on" : ""}`}>{row?.checked ? <Checkmark16Regular aria-hidden="true" /> : null}{!row ? "Checking" : row.checked ? "On" : "Off"}</span>
                  {row ? (
                    <button
                      className={row.checked ? "ui-control" : "ui-control ui-control--primary"}
                      type="button"
                      aria-describedby={`file-manager-${part}`}
                      disabled={Boolean(busy) || row.disabled}
                      onClick={() => void change(part, !row.checked)}
                    >
                      {busy === part ? <ArrowClockwise20Regular className="spin" /> : null}{row.checked ? "Turn Off" : "Turn On"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
