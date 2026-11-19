import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { resolveLocale, translations } from "../src/auth/localization.js";
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

  it("supports German and English with deterministic English fallback", () => {
    expect(resolveLocale("de-DE")).toBe("de");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("fr-FR")).toBe("en");
    expect(translations("de").signIn).toBe("Anmeldung starten");
    expect(translations("en").signIn).toBe("Start sign-in");
    expect(translations("unknown")).toBe(translations("en"));
  });
});
