import type { PiOAuthHooks } from "./pi-runtime-config.js";

interface PendingSignIn {
  controller: AbortController;
  /** Resolved by `finish`, once the sign-in no longer holds the setup lock. */
  settled: Promise<void>;
  paste?: (value: string) => void;
}

/** How long a new sign-in waits for a cancelled one to let go of the setup lock. */
const SETTLE_WAIT_MS = 10_000;

/**
 * The provider sign-in the app is waiting on, so the window that started it
 * can cancel it or finish it with a pasted link, without a dialog.
 *
 * A browser sign-in normally completes on its own: the provider sends the
 * browser back to a callback on this Mac. Pi also asks for the final link in
 * case that callback never arrives; the app takes that link only when the
 * person chooses Paste Link, instead of showing a dialog the moment the
 * browser opens. One sign-in runs at a time, and starting another cancels the
 * one before it, so an abandoned sign-in never holds the setup lock.
 */
export class ProviderSignIns {
  #current: PendingSignIn | null = null;

  /**
   * Cancels any sign-in in progress and waits for it to settle, then wraps the
   * desktop hooks for a new one; call the returned `finish` when it settles.
   */
  async begin(hooks: PiOAuthHooks): Promise<{ hooks: PiOAuthHooks; cancelled(): boolean; finish(): void }> {
    for (let previous = this.#current; previous; previous = this.#current) {
      this.#end(previous);
      await Promise.race([previous.settled, new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS).unref?.())]);
    }
    const controller = new AbortController();
    let settle!: () => void;
    const current: PendingSignIn = { controller, settled: new Promise<void>((resolve) => { settle = resolve; }) };
    this.#current = current;
    const signal = hooks.signal ? AbortSignal.any([hooks.signal, controller.signal]) : controller.signal;
    return {
      hooks: {
        ...hooks,
        signal,
        // Browser sign-in on this Mac is what the app runs; the other methods
        // are for signing in from another device.
        async select(input) {
          return input.options.some((option) => option.id === "browser") ? "browser" : hooks.select(input);
        },
        manualCodeInput(promptSignal) {
          return new Promise<string>((resolve, reject) => {
            const abort = () => {
              if (current.paste === accept) current.paste = undefined;
              reject(promptSignal?.reason ?? new Error("Provider sign-in cancelled."));
            };
            const accept = (value: string) => {
              promptSignal?.removeEventListener("abort", abort);
              current.paste = undefined;
              resolve(value);
            };
            if (promptSignal?.aborted) { abort(); return; }
            promptSignal?.addEventListener("abort", abort, { once: true });
            current.paste = accept;
          });
        },
      },
      cancelled: () => controller.signal.aborted,
      finish: () => {
        current.paste = undefined;
        if (this.#current === current) this.#current = null;
        settle();
      },
    };
  }

  /** Cancels the sign-in in progress. False when none is. */
  cancel(): boolean {
    const current = this.#current;
    if (!current) return false;
    this.#end(current);
    return true;
  }

  #end(signIn: PendingSignIn): void {
    if (this.#current === signIn) this.#current = null;
    signIn.paste = undefined;
    signIn.controller.abort(new Error("Provider sign-in cancelled."));
  }

  /** Whether the sign-in in progress is waiting and would take a pasted link. */
  get acceptsPaste(): boolean {
    return Boolean(this.#current?.paste);
  }

  /** Finishes the sign-in in progress with the link or code its browser page ended on. */
  paste(value: string): boolean {
    const accept = this.#current?.paste;
    if (!accept) return false;
    accept(value);
    return true;
  }
}

