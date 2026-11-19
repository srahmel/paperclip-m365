import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DOWNLOAD_ARTIFACT_SHA = "9000827ccba6bdab643e8b6fd33ac0654aef8333";

describe("package identity CI maintenance", () => {
  it("pins both official download-artifact calls to the documented Node 24 release", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/wp01-plugin-package.yml", import.meta.url),
      "utf8",
    );
    const pins = workflow.match(/actions\/download-artifact@([0-9a-f]{40})/g) ?? [];

    expect(pins).toEqual([
      `actions/download-artifact@${DOWNLOAD_ARTIFACT_SHA}`,
      `actions/download-artifact@${DOWNLOAD_ARTIFACT_SHA}`,
    ]);
    expect(workflow).toContain("Compare SHA-256 and normalized content lists");
    expect(workflow).toContain("cmp \"${RUNNER_TEMP}/linux/paperclip-plugin-m365-0.1.0.tgz\"");
    expect(workflow).toContain("Upload the single hash-bound acceptance artifact");
  });
});
