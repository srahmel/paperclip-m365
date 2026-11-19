import { ServerError, type AccountInfo } from "@azure/msal-node";
import { describe, expect, it } from "vitest";
import { MicrosoftAuthError } from "../src/auth/connection-manager.js";
import { MsalDeviceCodeProvider } from "../src/auth/msal-provider.js";

const account: AccountInfo = {
  homeAccountId: "synthetic-account",
  environment: "login.microsoftonline.com",
  tenantId: "22222222-2222-4222-8222-222222222222",
  username: "synthetic@example.test",
  localAccountId: "synthetic-local-account",
};

describe("MsalDeviceCodeProvider", () => {
  it("exposes only the human challenge fields and serialized cache", async () => {
    const application = new SyntheticMsalApplication();
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      now: () => new Date("2026-11-19T10:00:00.000Z"),
      createApplication: () => application,
    });
    let challenge: unknown;

    const result = await provider.signIn({
      connectionId: "33333333-3333-4333-8333-333333333333",
      expectedTenantId: account.tenantId,
      serializedCache: null,
      onChallenge: (value) => { challenge = value; },
    });

    expect(challenge).toEqual({
      userCode: "synthetic-user-code",
      verificationUri: "https://microsoft.example.test/device",
      expiresAt: "2026-11-19T10:15:00.000Z",
    });
    expect(JSON.stringify(challenge)).not.toContain("synthetic-provider-device-code");
    expect(result).toEqual({
      account: {
        homeAccountId: account.homeAccountId,
        tenantId: account.tenantId,
        username: account.username,
      },
      serializedCache: "serialized-cache",
    });
  });

  it("loads the selected cached account for silent token acquisition", async () => {
    const application = new SyntheticMsalApplication();
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      createApplication: () => application,
    });

    const result = await provider.acquireToken({
      account: {
        homeAccountId: account.homeAccountId,
        tenantId: account.tenantId,
        username: account.username,
      },
      scopes: ["Mail.Read"],
      serializedCache: "encrypted-boundary-plaintext",
    });

    expect(application.deserialized).toBe("encrypted-boundary-plaintext");
    expect(application.requestedScopes).toEqual(["Mail.Read"]);
    expect(result).toEqual({
      ["accessToken"]: "synthetic-access-material",
      serializedCache: "serialized-cache",
    });
  });

  it("classifies invalid_grant as revoked consent", async () => {
    const application = new SyntheticMsalApplication();
    application.silentError = new ServerError("invalid_grant", "synthetic-correlation");
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      createApplication: () => application,
    });

    await expect(provider.acquireToken({
      account: {
        homeAccountId: account.homeAccountId,
        tenantId: account.tenantId,
        username: account.username,
      },
      scopes: ["Mail.Read"],
      serializedCache: "cache",
    })).rejects.toEqual(new MicrosoftAuthError("consent_revoked"));
  });

  it("propagates shutdown cancellation to the MSAL device-code request", async () => {
    const application = new SyntheticMsalApplication();
    application.waitForCancellation = true;
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      createApplication: () => application,
    });
    const controller = new AbortController();
    const signIn = provider.signIn({
      connectionId: "33333333-3333-4333-8333-333333333333",
      expectedTenantId: account.tenantId,
      serializedCache: null,
      signal: controller.signal,
    });
    await application.deviceRequestStarted;

    controller.abort(new Error("authentication_shutdown"));

    await expect(signIn).rejects.toThrow("authentication_shutdown");
    expect(application.deviceRequest?.cancel).toBe(true);
  });

  it("does not report an aborted silent request settled before the provider actually finishes", async () => {
    const application = new SyntheticMsalApplication();
    const providerResult = deferred<Awaited<ReturnType<SyntheticMsalApplication["acquireTokenSilent"]>>>();
    application.silentResult = providerResult.promise;
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      createApplication: () => application,
    });
    const controller = new AbortController();
    let settled = false;
    const token = provider.acquireToken({
      account: { homeAccountId: account.homeAccountId, tenantId: account.tenantId, username: account.username },
      scopes: ["Mail.Read"],
      serializedCache: "cache",
      signal: controller.signal,
    }).finally(() => { settled = true; });
    await application.silentRequestStarted;

    controller.abort(new Error("authentication_shutdown"));
    const earlyOutcome = await Promise.race([
      token.then(() => "settled", () => "settled"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(earlyOutcome).toBe("pending");
    expect(settled).toBe(false);
    providerResult.resolve({ account, ["accessToken"]: "late-token" } as Awaited<ReturnType<import("@azure/msal-node").PublicClientApplication["acquireTokenSilent"]>>);
    await expect(token).rejects.toThrow("authentication_shutdown");
  });

  it("does not start silent acquisition when the signal is already aborted", async () => {
    const application = new SyntheticMsalApplication();
    const provider = new MsalDeviceCodeProvider({
      clientId: "11111111-1111-4111-8111-111111111111",
      signInScopes: ["User.Read"],
      createApplication: () => application,
    });
    const controller = new AbortController();
    controller.abort(new Error("authentication_shutdown"));

    await expect(provider.acquireToken({
      account: { homeAccountId: account.homeAccountId, tenantId: account.tenantId, username: account.username },
      scopes: ["Mail.Read"],
      serializedCache: "cache",
      signal: controller.signal,
    })).rejects.toThrow("authentication_shutdown");
    expect(application.silentCalls).toBe(0);
  });
});

class SyntheticMsalApplication {
  deserialized: string | null = null;
  requestedScopes: string[] = [];
  silentError: Error | null = null;
  silentResult: Promise<Awaited<ReturnType<import("@azure/msal-node").PublicClientApplication["acquireTokenSilent"]>>> | null = null;
  silentCalls = 0;
  readonly silentRequestStarted: Promise<void>;
  private markSilentRequestStarted!: () => void;
  waitForCancellation = false;
  deviceRequest: Parameters<import("@azure/msal-node").PublicClientApplication["acquireTokenByDeviceCode"]>[0] | null = null;
  readonly deviceRequestStarted: Promise<void>;
  private markDeviceRequestStarted!: () => void;

  constructor() {
    this.deviceRequestStarted = new Promise((resolve) => { this.markDeviceRequestStarted = resolve; });
    this.silentRequestStarted = new Promise((resolve) => { this.markSilentRequestStarted = resolve; });
  }

  getTokenCache() {
    return {
      deserialize: (cache: string) => { this.deserialized = cache; },
      serialize: () => "serialized-cache",
      getAccountByHomeId: async (homeAccountId: string) => homeAccountId === account.homeAccountId ? account : null,
    } as ReturnType<import("@azure/msal-node").PublicClientApplication["getTokenCache"]>;
  }

  async acquireTokenByDeviceCode(request: Parameters<import("@azure/msal-node").PublicClientApplication["acquireTokenByDeviceCode"]>[0]) {
    this.deviceRequest = request;
    this.markDeviceRequestStarted();
    request.deviceCodeCallback({
      userCode: "synthetic-user-code",
      deviceCode: "synthetic-provider-device-code",
      verificationUri: "https://microsoft.example.test/device",
      expiresIn: 900,
      interval: 5,
      message: "synthetic message",
    });
    if (this.waitForCancellation) {
      while (!request.cancel) await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("authentication_shutdown");
    }
    return { account } as Awaited<ReturnType<import("@azure/msal-node").PublicClientApplication["acquireTokenByDeviceCode"]>>;
  }

  async acquireTokenSilent(request: Parameters<import("@azure/msal-node").PublicClientApplication["acquireTokenSilent"]>[0]) {
    this.silentCalls += 1;
    this.markSilentRequestStarted();
    this.requestedScopes = [...request.scopes];
    if (this.silentError) throw this.silentError;
    if (this.silentResult) return this.silentResult;
    return {
      account,
      ["accessToken"]: "synthetic-access-material",
    } as Awaited<ReturnType<import("@azure/msal-node").PublicClientApplication["acquireTokenSilent"]>>;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
