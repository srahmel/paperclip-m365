import { describe, expect, it, vi } from "vitest";
import { appConfigErrorMessage, appFields, configReady, loadAppConfig, readOnlyPilotScopes, sameConfigValue, saveAppConfig } from "../src/ui/app-config.js";

const companyId = "test-company";
const fields = { microsoftTenantId: "11111111-1111-4111-8111-111111111111", microsoftClientId: "22222222-2222-4222-8222-222222222222", secretId: "existing-secret" };
const config = { ...fields, cacheEncryptionKey: { type: "secret_ref", secretId: fields.secretId, version: 2 }, signInScopes: ["User.Read"], futureSetting: { enabled: true } };
function response(configJson: unknown, status = 200) { return new Response(JSON.stringify({ companyId, configJson }), { status }); }

describe("host app configuration", () => {
  it("confirms JSONB responses with reordered nested object keys", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(config)).mockResolvedValueOnce(response({
      ...config, cacheEncryptionKey: { version: 2, secretId: fields.secretId, type: "secret_ref" },
    }));
    await expect(saveAppConfig(companyId, fields, fetcher)).resolves.toEqual(config);
    expect(sameConfigValue({ a: [{ b: 1, c: 2 }] }, { a: [{ c: 2, b: 1 }] })).toBe(true);
    expect(sameConfigValue(["User.Read", "Mail.Read"], ["Mail.Read", "User.Read"])).toBe(false);
    expect(sameConfigValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameConfigValue({ a: null }, {})).toBe(false);
  });

  it.each([
    [401, "arbitrary sensitive server content", "session"],
    [403, "arbitrary sensitive server content", "administrator"],
    [400, "Invalid secret_ref binding at cacheEncryptionKey", "secret reference"],
    [400, "Configuration does not match the plugin's instanceConfigSchema", "format"],
    [500, "arbitrary sensitive server content", "request failed"],
  ])("shows sanitized diagnostics for HTTP %s", async (status, error, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error }), { status: Number(status) }));
    try { await loadAppConfig(companyId, fetcher); throw new Error("Expected rejection"); }
    catch (failure) {
      const message = appConfigErrorMessage(failure, false);
      expect(message).toContain(expected);
      expect(message).toContain(`HTTP ${status}`);
      expect(message).not.toContain("arbitrary sensitive server content");
    }
  });
  it("loads only the company-scoped host endpoint with session credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(config));
    expect(await loadAppConfig(companyId, fetcher)).toEqual(config);
    expect(fetcher).toHaveBeenCalledWith(`/api/plugins/srahmel.m365/config?companyId=${companyId}`, expect.objectContaining({ credentials: "same-origin", redirect: "error", cache: "no-store" }));
  });

  it("preserves fresh unknown settings, scopes and a concurrently changed secret reference", async () => {
    const latest = { ...config, cacheEncryptionKey: { type: "secret_ref", secretId: "new-reference", version: 7 } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockImplementationOnce(async (_, init) => response(JSON.parse(String(init?.body)).configJson));
    expect(await saveAppConfig(companyId, fields, fetcher)).toEqual(latest);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe("/api/plugins/srahmel.m365/config");
  });

  it("saves IDs and explicitly selected pilot scopes without requiring or creating a key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("null")).mockImplementationOnce(async (_, init) => response(JSON.parse(String(init?.body)).configJson));
    const saved = await saveAppConfig(companyId, { ...fields, secretId: "" }, fetcher, { useReadOnlyPilot: true });
    expect(saved.signInScopes).toEqual(readOnlyPilotScopes);
    expect(saved).not.toHaveProperty("cacheEncryptionKey");
    expect(configReady(saved)).toBe(false);
  });

  it("changes only an explicitly edited secret reference and preserves an empty input", async () => {
    for (const secretId of ["replacement", ""]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(config)).mockImplementationOnce(async (_, init) => response(JSON.parse(String(init?.body)).configJson));
      const saved = await saveAppConfig(companyId, { ...fields, secretId }, fetcher, { updateSecret: true });
      expect(saved.cacheEncryptionKey).toEqual(secretId ? { type: "secret_ref", secretId, version: "latest" } : config.cacheEncryptionKey);
    }
  });

  it.each([401, 403, 500])("rejects HTTP %s on save", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(config)).mockResolvedValueOnce(response(config, status));
    await expect(saveAppConfig(companyId, fields, fetcher)).rejects.toThrow();
  });

  it.each(["null", "{}", "<html>Login</html>", JSON.stringify({ companyId: "another-company", configJson: config }), JSON.stringify({ companyId, configJson: { microsoftTenantId: fields.microsoftTenantId, microsoftClientId: fields.microsoftClientId } })])("rejects unconfirmed save response %s", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(config)).mockResolvedValueOnce(new Response(body));
    await expect(saveAppConfig(companyId, fields, fetcher)).rejects.toThrow();
  });

  it("does not write when the fresh read fails or IDs are invalid", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(config, 403));
    await expect(saveAppConfig(companyId, fields, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(saveAppConfig(companyId, { ...fields, microsoftClientId: "invalid" }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires all prerequisites and never exposes a legacy raw key as a reference", () => {
    expect(configReady(config)).toBe(true);
    for (const invalid of [{ ...config, signInScopes: [] }, { ...config, cacheEncryptionKey: "raw-secret" }, { ...config, cacheEncryptionKey: { type: "secret_ref", secretId: "x", version: 0 } }]) expect(configReady(invalid)).toBe(false);
    expect(appFields({ cacheEncryptionKey: "raw-secret" }).secretId).toBe("");
  });
});
