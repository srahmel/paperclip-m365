import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  ServerError,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-node";
import {
  MicrosoftAuthError,
  type MicrosoftAccount,
  type MicrosoftAuthProvider,
} from "./connection-manager.js";

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
type MsalApplication = Pick<
  PublicClientApplication,
  "acquireTokenByDeviceCode" | "acquireTokenSilent" | "getTokenCache"
>;
type MsalApplicationFactory = (
  config: ConstructorParameters<typeof PublicClientApplication>[0],
) => MsalApplication;

export class MsalDeviceCodeProvider implements MicrosoftAuthProvider {
  readonly #clientId: string;
  readonly #signInScopes: string[];
  readonly #now: () => Date;
  readonly #createApplication: MsalApplicationFactory;

  constructor(input: {
    clientId: string;
    signInScopes: string[];
    now?: () => Date;
    createApplication?: MsalApplicationFactory;
  }) {
    this.#clientId = input.clientId;
    this.#signInScopes = [...input.signInScopes];
    this.#now = input.now ?? (() => new Date());
    this.#createApplication = input.createApplication ?? ((config) => new PublicClientApplication(config));
  }

  async signIn(input: Parameters<MicrosoftAuthProvider["signIn"]>[0]) {
    const application = this.#application(input.expectedTenantId);
    if (input.serializedCache) {
      application.getTokenCache().deserialize(input.serializedCache);
    }

    const result = await application.acquireTokenByDeviceCode({
      scopes: this.#signInScopes,
      deviceCodeCallback: (response) => {
        input.onChallenge?.({
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          expiresAt: new Date(this.#now().getTime() + response.expiresIn * 1_000).toISOString(),
        });
      },
    });
    const account = requireAccount(result);
    return {
      account: toMicrosoftAccount(account),
      serializedCache: application.getTokenCache().serialize(),
    };
  }

  async acquireToken(input: Parameters<MicrosoftAuthProvider["acquireToken"]>[0]) {
    const application = this.#application(input.account.tenantId);
    application.getTokenCache().deserialize(input.serializedCache);
    const cachedAccount = await application.getTokenCache().getAccountByHomeId(input.account.homeAccountId);
    if (!cachedAccount || cachedAccount.tenantId !== input.account.tenantId) {
      throw new MicrosoftAuthError("interaction_required");
    }
    try {
      const result = await application.acquireTokenSilent({
        account: cachedAccount,
        scopes: [...input.scopes],
      });
      return {
        ["accessToken"]: result.accessToken,
        serializedCache: application.getTokenCache().serialize(),
      };
    } catch (error) {
      if (error instanceof ServerError && ["invalid_grant", "consent_required"].includes(error.errorCode)) {
        throw new MicrosoftAuthError("consent_revoked");
      }
      if (error instanceof InteractionRequiredAuthError || error instanceof ServerError) {
        throw new MicrosoftAuthError("interaction_required");
      }
      throw error;
    }
  }

  #application(tenantId: string): MsalApplication {
    return this.#createApplication({
      auth: {
        clientId: this.#clientId,
        authority: `${MICROSOFT_AUTHORITY}/${encodeURIComponent(tenantId)}`,
      },
      system: {
        loggerOptions: {
          loggerCallback: () => undefined,
          piiLoggingEnabled: false,
        },
      },
    });
  }
}

function requireAccount(result: AuthenticationResult | null): AccountInfo {
  if (!result?.account) throw new MicrosoftAuthError("interaction_required");
  return result.account;
}

function toMicrosoftAccount(account: AccountInfo): MicrosoftAccount {
  return {
    homeAccountId: account.homeAccountId,
    tenantId: account.tenantId,
    username: account.username,
  };
}
