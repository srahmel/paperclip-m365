import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("plugin schema migration", () => {
  it("keeps the atomic cache migration within declarative host-supported SQL", async () => {
    const sql = await readFile(new URL("../migrations/003_atomic_cache_state.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN cache_version bigint NOT NULL DEFAULT 0");
    expect(sql).toContain("connections_cache_shape");
    expect(sql).toContain("connection.company_id = cache.company_id AND connection.id = cache.connection_id");
    expect(sql).toContain("SET iv = '', ciphertext = '', authentication_tag = ''");
    expect(sql).not.toMatch(/\bCREATE\s+(?:FUNCTION|TRIGGER)|\bDELETE\s+FROM|\bTRUNCATE\b/i);
  });
  it("creates only the additive scaffold metadata table in the derived namespace", async () => {
    const sql = await readFile(
      new URL("../migrations/001_scaffold_metadata.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain(
      "CREATE TABLE plugin_m365_8b2a74e8fa.scaffold_metadata",
    );
    expect(sql).toContain("schema_version integer PRIMARY KEY");
    expect(sql).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(sql).not.toContain("public.");
  });

  it("adds company-scoped connections and encrypted versioned token caches", async () => {
    const sql = await readFile(
      new URL("../migrations/002_auth_connections.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("PRIMARY KEY (company_id, id)");
    expect(sql).toContain("PRIMARY KEY (company_id, connection_id)");
    expect(sql).toContain("cache_version bigint NOT NULL");
    expect(sql).toContain("generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0)");
    expect(sql).toContain("algorithm = 'aes-256-gcm'");
    expect(sql).toContain("ON DELETE CASCADE");
    expect(sql).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE)\b/i);
    expect(sql).not.toContain("public.");
  });
});
