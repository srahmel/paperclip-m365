import { describe, expect, it } from "vitest";
import { AuthenticationSessionRegistry } from "../src/auth/auth-session-registry.js";

const binding = {
  companyId: "company-a",
  initiatorUserId: "user-a",
  connectionId: "connection-a",
};

describe("AuthenticationSessionRegistry", () => {
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
