import { randomUUID } from "node:crypto";

export type AuthenticationChallenge = {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
};

type SessionState = "pending" | "challenge" | "completed" | "failed" | "cancelled";

type AuthenticationSession = {
  operationId: string;
  companyId: string;
  initiatorUserId: string;
  connectionId: string;
  state: SessionState;
  challenge: AuthenticationChallenge | null;
  expiresAt: number;
  terminalAt: number | null;
  controller: AbortController;
  task: Promise<void>;
};

type AuthenticationSessionInput = {
  companyId: string;
  initiatorUserId: string;
  connectionId: string;
  run: (input: {
    signal: AbortSignal;
    onChallenge: (challenge: AuthenticationChallenge) => void;
  }) => Promise<void>;
};

export type AuthenticationSessionReservation = {
  start(input: AuthenticationSessionInput): string;
  release(): void;
};

export class AuthenticationSessionRegistry {
  readonly #sessions = new Map<string, AuthenticationSession>();
  readonly #active = new Set<Promise<void>>();
  readonly #reservations = new Set<Promise<void>>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #terminalRetentionMs: number;
  readonly #maxRetainedSessions: number;
  #cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  #shuttingDown = false;

  constructor(input: {
    now?: () => Date;
    newId?: () => string;
    terminalRetentionMs?: number;
    maxRetainedSessions?: number;
  } = {}) {
    this.#now = input.now ?? (() => new Date());
    this.#newId = input.newId ?? randomUUID;
    this.#terminalRetentionMs = input.terminalRetentionMs ?? 60_000;
    this.#maxRetainedSessions = input.maxRetainedSessions ?? 256;
    if (!Number.isSafeInteger(this.#terminalRetentionMs) || this.#terminalRetentionMs < 1) {
      throw new Error("authentication_terminal_retention_invalid");
    }
    if (!Number.isSafeInteger(this.#maxRetainedSessions) || this.#maxRetainedSessions < 1) {
      throw new Error("authentication_session_capacity_invalid");
    }
  }

  reserve(): AuthenticationSessionReservation {
    if (this.#shuttingDown) throw new Error("authentication_shutdown");
    this.#sweep();
    this.#makeRoom();
    let finish!: () => void;
    const marker = new Promise<void>((resolve) => { finish = resolve; });
    this.#reservations.add(marker);
    this.#active.add(marker);
    let reserved = true;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      this.#reservations.delete(marker);
      this.#active.delete(marker);
      finish();
    };
    return {
      release,
      start: (input) => {
        if (!reserved) throw new Error("authentication_reservation_invalid");
        if (this.#shuttingDown) {
          release();
          throw new Error("authentication_shutdown");
        }
        // Replace the reservation with active work synchronously, counting one slot.
        release();
        return this.#start(input);
      },
    };
  }

  start(input: AuthenticationSessionInput): string {
    return this.reserve().start(input);
  }

  #start(input: AuthenticationSessionInput): string {
    const operationId = this.#newId();
    const controller = new AbortController();
    const session: AuthenticationSession = {
      operationId,
      companyId: input.companyId,
      initiatorUserId: input.initiatorUserId,
      connectionId: input.connectionId,
      state: "pending",
      challenge: null,
      expiresAt: Number.POSITIVE_INFINITY,
      terminalAt: null,
      controller,
      task: Promise.resolve(),
    };
    const task = Promise.resolve().then(async () => {
      try {
        await input.run({
          signal: controller.signal,
          onChallenge: (challenge) => {
            if (controller.signal.aborted) return;
            session.challenge = { ...challenge };
            session.expiresAt = Date.parse(challenge.expiresAt);
            session.state = "challenge";
            this.#scheduleCleanup();
          },
        });
        this.#setTerminal(session, controller.signal.aborted ? "cancelled" : "completed");
      } catch {
        this.#setTerminal(session, controller.signal.aborted ? "cancelled" : "failed");
      } finally {
        this.#scheduleCleanup();
      }
    });
    session.task = task;
    this.#sessions.set(operationId, session);
    this.#active.add(task);
    void task.finally(() => this.#active.delete(task));
    return operationId;
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#shuttingDown) return Promise.reject(new Error("authentication_shutdown"));
    if (this.#active.size >= this.#maxRetainedSessions) {
      return Promise.reject(new Error("authentication_session_capacity"));
    }
    const task = Promise.resolve().then(operation);
    const marker = task.then(() => undefined, () => undefined);
    this.#active.add(marker);
    void task.finally(() => this.#active.delete(marker)).catch(() => undefined);
    return task;
  }

  read(input: {
    operationId: string;
    companyId: string;
    initiatorUserId: string;
    connectionId: string;
  }): { operationId: string; connectionId: string; state: SessionState; challenge?: AuthenticationChallenge } {
    this.#sweep();
    const session = this.#sessions.get(input.operationId);
    if (
      !session ||
      session.companyId !== input.companyId ||
      session.initiatorUserId !== input.initiatorUserId ||
      session.connectionId !== input.connectionId ||
      session.state === "cancelled"
    ) {
      throw new Error("authentication_session_not_found");
    }
    const result: ReturnType<AuthenticationSessionRegistry["read"]> = {
      operationId: session.operationId,
      connectionId: session.connectionId,
      state: session.state,
    };
    if (session.challenge) {
      result.challenge = { ...session.challenge };
      session.challenge = null;
      this.#scheduleCleanup();
    }
    return result;
  }

  async cancelConnection(companyId: string, connectionId: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.companyId === companyId && session.connectionId === connectionId,
    );
    for (const session of sessions) {
      session.controller.abort(new Error("operation_invalidated"));
      this.#setTerminal(session, "cancelled");
    }
    await Promise.allSettled(sessions.map((session) => session.task));
    for (const session of sessions) this.#sessions.delete(session.operationId);
    this.#scheduleCleanup();
  }

  idleState(): "none" | "present" {
    return this.#active.size === 0 && this.#cleanupTimer === null ? "none" : "present";
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#cleanupTimer !== null) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = null;
    for (const session of this.#sessions.values()) {
      session.controller.abort(new Error("authentication_shutdown"));
      this.#setTerminal(session, "cancelled");
    }
    await Promise.allSettled([...this.#active]);
    this.#sessions.clear();
  }

  #setTerminal(session: AuthenticationSession, state: Extract<SessionState, "completed" | "failed" | "cancelled">): void {
    session.state = state;
    session.challenge = null;
    session.expiresAt = Number.POSITIVE_INFINITY;
    session.terminalAt ??= this.#now().getTime();
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const session of this.#sessions.values()) {
      if (session.state === "challenge" && now >= session.expiresAt) {
        session.controller.abort(new Error("authentication_challenge_expired"));
        this.#setTerminal(session, "cancelled");
      }
      if (session.terminalAt !== null && now - session.terminalAt >= this.#terminalRetentionMs) {
        this.#sessions.delete(session.operationId);
      }
    }
  }

  #makeRoom(): void {
    if (this.#active.size >= this.#maxRetainedSessions) {
      throw new Error("authentication_session_capacity");
    }
    while (this.#sessions.size + this.#reservations.size >= this.#maxRetainedSessions) {
      const terminal = [...this.#sessions.values()]
        .filter((session) => session.terminalAt !== null)
        .sort((left, right) => left.terminalAt! - right.terminalAt!)[0];
      if (!terminal) throw new Error("authentication_session_capacity");
      this.#sessions.delete(terminal.operationId);
    }
    this.#scheduleCleanup();
  }

  #scheduleCleanup(): void {
    if (this.#cleanupTimer !== null) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = null;
    if (this.#shuttingDown) return;
    const deadlines = [...this.#sessions.values()].flatMap((session) => {
      if (session.state === "challenge") return [session.expiresAt];
      if (session.terminalAt !== null) return [session.terminalAt + this.#terminalRetentionMs];
      return [];
    });
    if (deadlines.length === 0) return;
    const delay = Math.max(0, Math.min(...deadlines) - this.#now().getTime());
    this.#cleanupTimer = setTimeout(() => {
      this.#cleanupTimer = null;
      this.#sweep();
      this.#scheduleCleanup();
    }, delay);
    this.#cleanupTimer.unref?.();
  }
}
