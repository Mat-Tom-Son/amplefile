import { AmpleFileCheckService, type AmpleFileCheckServiceOptions } from "../../src/local/checks/check-service.js";
import type { AmpleFileSettleSignal } from "../../src/local/automations/settle-signal.js";
import type { LocalApiHandle } from "../../src/local/server.js";
import type { AmpleFileKernel } from "../../src/local/amplefile-kernel.js";

/** One service for desktop status, renderer actions, CLI and Automation runs. */
export function createDesktopCheckService(options: {
  kernel: AmpleFileKernel;
  settleSignal: AmpleFileSettleSignal;
  getLocalApi: () => Promise<Pick<LocalApiHandle, "reviewCheck">>;
  /** Tells app views that read a selected Check to re-read (F30). Ids only. */
  onResultChanged?: AmpleFileCheckServiceOptions["onResultChanged"];
}): AmpleFileCheckService {
  return new AmpleFileCheckService({
    kernel: options.kernel,
    settleSignal: options.settleSignal,
    ...(options.onResultChanged ? { onResultChanged: options.onResultChanged } : {}),
    // The read CLI exists before the interactive API. Resolve its transport
    // only when an authorized model run actually needs the AmpleFile agent's runtime.
    reviewModel: async (request) => (await options.getLocalApi()).reviewCheck(request),
  });
}
