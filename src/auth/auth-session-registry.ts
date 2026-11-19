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
  challengeConsumed: boolean;
  expiresAt: number;
  controller: AbortController;
  task: Promise<void>;
};

export class AuthenticationSessionRegistry {
  readonly #sessions = new Map<string, AuthenticationSession>();
  readonly #active = new Set<Promise<void>>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  #shuttingDown = false;

  constructor(input: { now?: () => Date; newId?: () => string } = {}) {
    this.#now = input.now ?? (() => new Date());
    this.#newId = input.newId ?? randomUUID;
  }

  start(input: {
    companyId: string;
    initiatorUserId: string;
    connectionId: string;
    run: (input: {
      signal: AbortSignal;
      onChallenge: (challenge: AuthenticationChallenge) => void;
    }) => Promise<void>;
  }): string {
    if (this.#shuttingDown) throw new Error("authentication_shutdown");
    const operationId = this.#newId();
    const controller = new AbortController();
    const session: AuthenticationSession = {
      operationId,
      companyId: input.companyId,
      initiatorUserId: input.initiatorUserId,
      connectionId: input.connectionId,
      state: "pending",
      challenge: null,
      challengeConsumed: false,
      expiresAt: Number.POSITIVE_INFINITY,
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
          },
        });
        if (!controller.signal.aborted) session.state = "completed";
      } catch {
        session.state = controller.signal.aborted ? "cancelled" : "failed";
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
    const session = this.#sessions.get(input.operationId);
    if (
      !session ||
      session.companyId !== input.companyId ||
      session.initiatorUserId !== input.initiatorUserId ||
      session.connectionId !== input.connectionId ||
      this.#now().getTime() >= session.expiresAt ||
      session.state === "cancelled"
    ) {
      throw new Error("authentication_session_not_found");
    }
    const result: ReturnType<AuthenticationSessionRegistry["read"]> = {
      operationId: session.operationId,
      connectionId: session.connectionId,
      state: session.state,
    };
    if (session.challenge && !session.challengeConsumed) {
      result.challenge = { ...session.challenge };
      session.challengeConsumed = true;
    }
    return result;
  }

  async cancelConnection(companyId: string, connectionId: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.companyId === companyId && session.connectionId === connectionId,
    );
    for (const session of sessions) {
      session.controller.abort(new Error("operation_invalidated"));
      session.challenge = null;
      session.state = "cancelled";
    }
    await Promise.allSettled(sessions.map((session) => session.task));
  }

  idleState(): "none" | "present" {
    return this.#active.size === 0 ? "none" : "present";
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const session of this.#sessions.values()) {
      session.controller.abort(new Error("authentication_shutdown"));
      session.challenge = null;
      session.state = "cancelled";
    }
    await Promise.allSettled([...this.#active]);
  }
}
