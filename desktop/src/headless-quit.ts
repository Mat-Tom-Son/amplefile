export interface HeadlessQuitHost {
  /** True once a person launched AmpleFile (Dock, Finder, a second instance). */
  interactiveRequested(): boolean;
  /** Increments for every CLI request this process accepts. */
  cliRequestGeneration(): number;
  /** Waits for the CLI queue and Pi state to drain, plus the idle grace. */
  waitForIdle(): Promise<void>;
  /** Removes crash-residue act tokens; must not throw. */
  removeActToken(): Promise<void>;
  /** Exits synchronously; called with no await between the last check and it. */
  quit(): void;
}

export type HeadlessQuitOutcome = "quit" | "interactive";

/**
 * A process started only for a CLI request quits once it has been idle. Any
 * await is a window in which a person may open AmpleFile or another CLI
 * request may arrive, so every decision is re-checked after the awaits and
 * `quit()` follows the final check synchronously. Interactive startup awaits
 * `whenTeardownSettled()` so it never races a teardown in flight.
 */
export class HeadlessQuitSequence {
  #teardown: Promise<void> | null = null;

  constructor(private readonly host: HeadlessQuitHost) {}

  whenTeardownSettled(): Promise<void> {
    return this.#teardown ?? Promise.resolve();
  }

  async run(): Promise<HeadlessQuitOutcome> {
    const host = this.host;
    for (;;) {
      while (!host.interactiveRequested()) {
        const observed = host.cliRequestGeneration();
        await host.waitForIdle();
        if (observed === host.cliRequestGeneration()) break;
      }
      if (host.interactiveRequested()) return "interactive";

      const observed = host.cliRequestGeneration();
      const stillIdle = () => !host.interactiveRequested() && observed === host.cliRequestGeneration();
      const teardown = host.removeActToken();
      this.#teardown = teardown.then(() => undefined, () => undefined);
      try {
        await teardown;
      } finally {
        this.#teardown = null;
      }

      if (host.interactiveRequested()) return "interactive";
      if (!stillIdle()) continue;
      host.quit();
      return "quit";
    }
  }
}
