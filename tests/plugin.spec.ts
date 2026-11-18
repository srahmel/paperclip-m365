import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("M365 plugin scaffold", () => {
  it("declares only the capabilities needed by its schema and settings entry", () => {
    expect(manifest).toMatchObject({
      id: "srahmel.m365",
      apiVersion: 1,
      version: "0.1.0",
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
      database: {
        namespaceSlug: "m365",
        migrationsDir: "migrations",
      },
    });
    expect(manifest.capabilities).toEqual([
      "database.namespace.migrate",
      "database.namespace.read",
      "instance.settings.register",
    ]);
    expect(manifest.tools).toBeUndefined();
    expect(manifest.apiRoutes).toBeUndefined();
    expect(manifest.jobs).toBeUndefined();
  });

  it("exposes content-free scaffold status through the worker seam", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("scaffold-status")).resolves.toEqual({
      status: "ready",
      version: "0.1.0",
      microsoftIntegration: "not-configured",
    });
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({
      status: "ok",
      message: "M365 plugin scaffold is ready",
    });
    await expect(
      plugin.definition.onIdleDrain?.(new AbortController().signal),
    ).resolves.toBe("none");
  });
});
