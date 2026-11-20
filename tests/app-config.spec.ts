import { describe, expect, it, vi } from "vitest";
import { appFields, configReady, loadAppConfig, readOnlyPilotScopes, saveAppConfig } from "../src/ui/app-config.js";

const companyId = "test-company";
const fields = { microsoftTenantId: "11111111-1111-4111-8111-111111111111", microsoftClientId: "22222222-2222-4222-8222-222222222222", secretId: "existing-secret" };
const config = { ...fields, cacheEncryptionKey: { type: "secret_ref", secretId: fields.secretId, version: 2 }, signInScopes: ["User.Read"], futureSetting: { enabled: true } };
function response(configJson: unknown, status = 200) { return new Response(JSON.stringify({ companyId, configJson }), { status }); }

describe("host app configuration", () => {
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
