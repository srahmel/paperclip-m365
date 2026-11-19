import { describe, expect, it } from "vitest";
import { AuthenticationPoller, type AuthenticationSession } from "../src/ui/authentication-poller.js";

describe("AuthenticationPoller", () => {
  it("never overlaps polls and ignores a response after stop", async () => {
    const scheduler = new ManualScheduler();
    const pending = deferred<AuthenticationSession>();
    const updates: AuthenticationSession[] = [];
    let calls = 0;
    const poller = new AuthenticationPoller(scheduler);
    poller.start({
      session: { operationId: "operation-a", connectionId: "connection-a", state: "pending" },
      load: async () => { calls += 1; return pending.promise; },
      onUpdate: (session) => updates.push(session),
      onTerminal: (session) => updates.push(session),
      onError: () => undefined,
    });

    scheduler.runNext();
    scheduler.runNext();
    expect(calls).toBe(1);
    poller.stop();
    pending.resolve({ operationId: "operation-a", connectionId: "connection-a", state: "challenge" });
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it("stops after completed, failed, or expired/error outcomes", async () => {
    for (const terminal of ["completed", "failed"] as const) {
      const scheduler = new ManualScheduler();
      const terminalResults: AuthenticationSession[] = [];
      const poller = new AuthenticationPoller(scheduler);
      poller.start({
        session: { operationId: "operation-a", connectionId: "connection-a", state: "pending" },
        load: async () => ({ operationId: "operation-a", connectionId: "connection-a", state: terminal }),
        onUpdate: () => undefined,
        onTerminal: (session) => terminalResults.push(session),
        onError: () => undefined,
      });
      scheduler.runNext();
      await Promise.resolve();
      await Promise.resolve();
      expect(terminalResults).toHaveLength(1);
      expect(scheduler.pending).toBe(0);
    }

    const scheduler = new ManualScheduler();
    let errors = 0;
    const poller = new AuthenticationPoller(scheduler);
    poller.start({
      session: { operationId: "operation-a", connectionId: "connection-a", state: "pending" },
      load: async () => { throw new Error("authentication_session_not_found"); },
      onUpdate: () => undefined,
      onTerminal: () => undefined,
      onError: () => { errors += 1; },
    });
    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toBe(1);
    expect(scheduler.pending).toBe(0);
  });
});

class ManualScheduler {
  readonly queue: Array<() => void> = [];
  get pending() { return this.queue.length; }
  set(callback: () => void) { this.queue.push(callback); return callback; }
  clear(handle: unknown) {
    const index = this.queue.indexOf(handle as () => void);
    if (index >= 0) this.queue.splice(index, 1);
  }
  runNext() { this.queue.shift()?.(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
