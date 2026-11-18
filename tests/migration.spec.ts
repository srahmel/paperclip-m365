import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("plugin schema migration", () => {
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
});
