
import type { RestrictedAppChangeDraft } from "./restricted-apps";

export function appChangeDraft(change: RestrictedAppChangeDraft): string {
  return `Change ${change.title} (${change.version}) using the prepared copy in ${JSON.stringify(change.sourcePath)}. Keep its app and package identity, and submit the changed package for review.\n\nWhat I'd like to change: `;
}
