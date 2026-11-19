export type AuthenticationSession = {
  operationId: string;
  connectionId: string;
  state: "pending" | "challenge" | "completed" | "failed";
  challenge?: { userCode: string; verificationUri: string; expiresAt: string };
};

type Scheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

export class ActionEpoch {
  #generation = 0;

  start(): number {
    this.#generation += 1;
    return this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }
}

export class AuthenticationPoller {
  readonly #scheduler: Scheduler;
  #generation = 0;
  #timer: unknown;
  #inFlight = false;

  constructor(scheduler: Scheduler = {
    set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }) {
    this.#scheduler = scheduler;
  }

  start(input: {
    session: AuthenticationSession;
    load: (session: AuthenticationSession) => Promise<AuthenticationSession>;
    onUpdate: (session: AuthenticationSession) => void;
    onTerminal: (session: AuthenticationSession) => void;
    onError: (error: unknown) => void;
  }): void {
    this.stop();
    const generation = this.#generation;
    const schedule = () => {
      if (generation !== this.#generation) return;
      this.#timer = this.#scheduler.set(() => { void poll(); }, 1_000);
    };
    const poll = async () => {
      if (generation !== this.#generation) return;
      if (this.#inFlight) {
        schedule();
        return;
      }
      this.#inFlight = true;
      try {
        const next = await input.load(input.session);
        if (generation !== this.#generation) return;
        if (next.state === "completed" || next.state === "failed") {
          this.stop();
          input.onTerminal(next);
          return;
        }
        input.session = next;
        input.onUpdate(next);
        schedule();
      } catch (error) {
        if (generation !== this.#generation) return;
        this.stop();
        input.onError(error);
      } finally {
        this.#inFlight = false;
      }
    };
    schedule();
  }

  stop(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) this.#scheduler.clear(this.#timer);
    this.#timer = undefined;
  }
}
