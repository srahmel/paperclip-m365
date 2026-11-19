import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationSessionRegistry } from "../src/auth/auth-session-registry.js";

const binding = {
  companyId: "company-a",
  initiatorUserId: "user-a",
  connectionId: "connection-a",
};

describe("AuthenticationSessionRegistry", () => {
  afterEach(() => vi.useRealTimers());
  it("reports background work until the last parallel operation completes", async () => {
    const registry = new AuthenticationSessionRegistry({
      newId: (() => { let id = 0; return () => `operation-${++id}`; })(),
    });
    const first = deferred<void>();
    const second = deferred<void>();
    registry.start({ ...binding, run: async () => first.promise });
    registry.start({ ...binding, connectionId: "connection-b", run: async () => second.promise });

    expect(registry.idleState()).toBe("present");
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.idleState()).toBe("present");
    second.resolve();
    await registry.shutdown();
    expect(registry.idleState()).toBe("none");
  });

  it("tracks a non-session token or cache operation until persistence finishes", async () => {
    const registry = new AuthenticationSessionRegistry();
    const persistence = deferred<void>();
    const operation = registry.track(async () => persistence.promise);

    expect(registry.idleState()).toBe("present");
    persistence.resolve();
    await operation;
    await Promise.resolve();
    expect(registry.idleState()).toBe("none");
  });

  it("aborts and awaits operations on shutdown without retaining a challenge", async () => {
    const registry = new AuthenticationSessionRegistry({ newId: () => "operation-a" });
    registry.start({
      ...binding,
      run: async ({ signal, onChallenge }) => {
        onChallenge({
          userCode: "private-code",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
        await untilAborted(signal);
      },
    });
    expect(registry.idleState()).toBe("present");

    await registry.shutdown();

    expect(registry.idleState()).toBe("none");
    expect(() => registry.read({ ...binding, operationId: "operation-a" }))
      .toThrow("authentication_session_not_found");
  });

  it("binds a one-time challenge to company, initiator, connection, operation and expiry", async () => {
    let now = new Date("2026-11-19T10:00:00.000Z");
    const registry = new AuthenticationSessionRegistry({ now: () => now, newId: () => "operation-a" });
    const completed = deferred<void>();
    registry.start({
      ...binding,
      run: async ({ onChallenge }) => {
        onChallenge({
          userCode: "private-code",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2026-11-19T10:05:00.000Z",
        });
        await completed.promise;
      },
    });
    await Promise.resolve();

    for (const wrong of [
      { ...binding, companyId: "company-b" },
      { ...binding, initiatorUserId: "user-b" },
      { ...binding, connectionId: "connection-b" },
    ]) {
      expect(() => registry.read({ ...wrong, operationId: "operation-a" }))
        .toThrow("authentication_session_not_found");
    }
    expect(registry.read({ ...binding, operationId: "operation-a" })).toMatchObject({
      state: "challenge",
      challenge: { userCode: "private-code" },
    });
    expect(registry.read({ ...binding, operationId: "operation-a" })).not.toHaveProperty("challenge");
    now = new Date("2026-11-19T10:05:00.000Z");
    expect(() => registry.read({ ...binding, operationId: "operation-a" }))
      .toThrow("authentication_session_not_found");
    completed.resolve();
    await registry.shutdown();
  });

  it("removes sensitive challenges on consumption, expiry and terminal completion", async () => {
    let now = new Date("2026-11-19T10:00:00.000Z");
    const registry = new AuthenticationSessionRegistry({
      now: () => now,
      newId: (() => { let id = 0; return () => `operation-${++id}`; })(),
      terminalRetentionMs: 1_000,
    });
    const first = deferred<void>();
    registry.start({
      ...binding,
      run: async ({ onChallenge }) => {
        onChallenge({
          userCode: "consume-once",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2026-11-19T10:05:00.000Z",
        });
        await first.promise;
      },
    });
    await Promise.resolve();
    expect(registry.read({ ...binding, operationId: "operation-1" })).toHaveProperty("challenge.userCode", "consume-once");
    expect(registry.read({ ...binding, operationId: "operation-1" })).not.toHaveProperty("challenge");
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.read({ ...binding, operationId: "operation-1" })).toMatchObject({ state: "completed" });

    const completedUnread = deferred<void>();
    registry.start({
      ...binding,
      connectionId: "connection-completed",
      run: async ({ onChallenge }) => {
        onChallenge({
          userCode: "must-not-survive-completion",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2026-11-19T10:05:00.000Z",
        });
        await completedUnread.promise;
      },
    });
    await Promise.resolve();
    completedUnread.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.read({ ...binding, connectionId: "connection-completed", operationId: "operation-2" }))
      .toEqual({ operationId: "operation-2", connectionId: "connection-completed", state: "completed" });

    const expired = deferred<void>();
    registry.start({
      ...binding,
      connectionId: "connection-b",
      run: async ({ onChallenge }) => {
        onChallenge({
          userCode: "expire-unread",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: "2026-11-19T10:00:01.000Z",
        });
        await expired.promise;
      },
    });
    await Promise.resolve();
    now = new Date("2026-11-19T10:00:01.000Z");
    expect(() => registry.read({ ...binding, connectionId: "connection-b", operationId: "operation-3" }))
      .toThrow("authentication_session_not_found");
    expired.resolve();
    await registry.shutdown();
  });

  it("bounds retained terminal sessions without evicting active work", async () => {
    let now = new Date("2026-11-19T10:00:00.000Z");
    const registry = new AuthenticationSessionRegistry({
      now: () => now,
      newId: (() => { let id = 0; return () => `operation-${++id}`; })(),
      terminalRetentionMs: 1_000,
      maxRetainedSessions: 2,
    });
    registry.start({ ...binding, connectionId: "connection-1", run: async () => undefined });
    registry.start({ ...binding, connectionId: "connection-2", run: async () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    registry.start({ ...binding, connectionId: "connection-3", run: async () => undefined });
    await Promise.resolve();
    await Promise.resolve();

    expect(() => registry.read({ ...binding, connectionId: "connection-1", operationId: "operation-1" }))
      .toThrow("authentication_session_not_found");
    expect(registry.read({ ...binding, connectionId: "connection-2", operationId: "operation-2" }))
      .toMatchObject({ state: "completed" });

    now = new Date("2026-11-19T10:00:02.000Z");
    expect(() => registry.read({ ...binding, connectionId: "connection-3", operationId: "operation-3" }))
      .toThrow("authentication_session_not_found");
    await registry.shutdown();

    const active = deferred<void>();
    const alsoActive = deferred<void>();
    const activeRegistry = new AuthenticationSessionRegistry({ maxRetainedSessions: 2 });
    activeRegistry.start({ ...binding, connectionId: "connection-4", run: async () => active.promise });
    activeRegistry.start({ ...binding, connectionId: "connection-5", run: async () => alsoActive.promise });
    expect(() => activeRegistry.start({ ...binding, connectionId: "connection-6", run: async () => undefined }))
      .toThrow("authentication_session_capacity");
    expect(activeRegistry.idleState()).toBe("present");
    active.resolve();
    alsoActive.resolve();
    await activeRegistry.shutdown();
  });

  it("reserves capacity before preparation and consumes exactly one slot", async () => {
    const registry = new AuthenticationSessionRegistry({ maxRetainedSessions: 1 });
    const reservation = registry.reserve();
    expect(registry.idleState()).toBe("present");
    expect(() => registry.reserve()).toThrow("authentication_session_capacity");
    await expect(registry.track(async () => undefined)).rejects.toThrow("authentication_session_capacity");
    const work = deferred<void>();
    const entered = deferred<void>();
    reservation.start({ ...binding, run: async () => { entered.resolve(); await work.promise; } });
    reservation.release(); // A preparation finally block cannot release the active session slot.
    await entered.promise;
    expect(() => registry.reserve()).toThrow("authentication_session_capacity");
    expect(() => reservation.start({ ...binding, run: async () => undefined }))
      .toThrow("authentication_reservation_invalid");
    work.resolve();
    await registry.shutdown();
    expect(registry.idleState()).toBe("none");
  });

  it("releases a failed preparation and rejects a released reservation", async () => {
    const registry = new AuthenticationSessionRegistry({ maxRetainedSessions: 1 });
    const failed = registry.reserve();
    failed.release();
    failed.release();
    expect(registry.idleState()).toBe("none");
    expect(() => failed.start({ ...binding, run: async () => undefined }))
      .toThrow("authentication_reservation_invalid");
    const retry = registry.reserve();
    retry.release();
    await registry.shutdown();
  });

  it("awaits reserved preparation on shutdown and prevents its late session start", async () => {
    const registry = new AuthenticationSessionRegistry({ maxRetainedSessions: 1 });
    const reservation = registry.reserve();
    let drained = false;
    const shutdown = registry.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(registry.idleState()).toBe("present");
    expect(() => registry.reserve()).toThrow("authentication_shutdown");
    const run = vi.fn(async () => undefined);
    expect(() => reservation.start({ ...binding, run })).toThrow("authentication_shutdown");
    await shutdown;
    expect(run).not.toHaveBeenCalled();
    expect(registry.idleState()).toBe("none");
  });

  it("includes reservations in the retained metadata limit", async () => {
    const registry = new AuthenticationSessionRegistry({
      maxRetainedSessions: 2,
      newId: (() => { let id = 0; return () => `bounded-${++id}`; })(),
    });
    registry.start({ ...binding, run: async () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const first = registry.reserve();
    const second = registry.reserve();
    expect(() => registry.read({ ...binding, operationId: "bounded-1" }))
      .toThrow("authentication_session_not_found");
    first.start({ ...binding, run: async () => undefined });
    second.start({ ...binding, run: async () => undefined });
    await registry.shutdown();
  });

  it("admits a session at capacity one and reserves the slot until its work settles", async () => {
    const registry = new AuthenticationSessionRegistry({ maxRetainedSessions: 1 });
    const completion = deferred<void>();
    const entered = deferred<void>();
    registry.start({ ...binding, run: async () => { entered.resolve(); await completion.promise; } });
    await entered.promise;
    const rejectedOperation = vi.fn(async () => undefined);
    await expect(registry.track(rejectedOperation)).rejects.toThrow("authentication_session_capacity");
    expect(rejectedOperation).not.toHaveBeenCalled();
    expect(() => registry.start({ ...binding, run: rejectedOperation })).toThrow("authentication_session_capacity");
    completion.resolve();
    await registry.shutdown();
    expect(registry.idleState()).toBe("none");
  });

  it("retains capacity and drains unfinished work after expired session metadata is removed", async () => {
    vi.useFakeTimers();
    const registry = new AuthenticationSessionRegistry({ terminalRetentionMs: 100, maxRetainedSessions: 1 });
    const persistence = deferred<void>();
    let aborted = false;
    registry.start({
      ...binding,
      run: async ({ signal, onChallenge }) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        onChallenge({ userCode: "synthetic-code", verificationUri: "https://microsoft.example.test/device",
          expiresAt: new Date(Date.now() + 100).toISOString() });
        // Simulate a provider/storage operation that settles after cancellation.
        await persistence.promise;
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(aborted).toBe(true);
    expect(registry.idleState()).toBe("present");
    expect(() => registry.start({ ...binding, run: async () => undefined })).toThrow("authentication_session_capacity");
    await expect(registry.track(async () => undefined)).rejects.toThrow("authentication_session_capacity");
    let drained = false;
    const shutdown = registry.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    persistence.resolve();
    await shutdown;
    expect(registry.idleState()).toBe("none");
    expect(() => registry.start({ ...binding, run: async () => undefined })).toThrow("authentication_shutdown");
    await expect(registry.track(async () => undefined)).rejects.toThrow("authentication_shutdown");
  });

  it("cleans an unread expired challenge and terminal status on deadlines without another registry call", async () => {
    vi.useFakeTimers();
    const registry = new AuthenticationSessionRegistry({
      now: () => new Date(Date.now()),
      newId: () => "operation-deadline",
      terminalRetentionMs: 1_000,
    });
    registry.start({
      ...binding,
      run: async ({ signal, onChallenge }) => {
        onChallenge({
          userCode: "expires-without-read",
          verificationUri: "https://microsoft.example.test/device",
          expiresAt: new Date(Date.now() + 1_000).toISOString(),
        });
        await untilAborted(signal);
      },
    });
    await Promise.resolve();
    expect(registry.idleState()).toBe("present");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.idleState()).toBe("present");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.idleState()).toBe("none");
    await registry.shutdown();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
