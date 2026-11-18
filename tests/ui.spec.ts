import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { SettingsPage } from "../src/ui/index.js";

describe("settings UI entrypoint", () => {
  it("exports the component declared by the manifest", () => {
    const slot = manifest.ui?.slots?.find((candidate) => candidate.id === "settings");

    expect(slot).toMatchObject({
      type: "settingsPage",
      exportName: "SettingsPage",
    });
    expect(SettingsPage).toBeTypeOf("function");
  });
});
