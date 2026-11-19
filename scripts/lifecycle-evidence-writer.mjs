import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";

export function createLifecycleEvidenceWriter({
  resultPath,
  phasePath,
  sourceRevision,
  writeRawResult = (line) => console.log(line),
  writeRawPhase = (line) => console.error(line),
}) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/, "lifecycle evidence revision is invalid");
  const writesCanonicalFiles = Boolean(resultPath || phasePath);
  if (writesCanonicalFiles) {
    assert(resultPath && phasePath, "both lifecycle evidence paths are required");
    writeFileSync(resultPath, "", { encoding: "utf8", flag: "wx" });
    writeFileSync(phasePath, "", { encoding: "utf8", flag: "wx" });
  }

  return {
    emitPhase(phase) {
      const line = JSON.stringify({
        check: "isolated-host-lifecycle-phase",
        phase,
        sourceRevision,
      });
      if (writesCanonicalFiles) {
        appendFileSync(phasePath, `${line}\n`, "utf8");
      }
      writeRawPhase(line);
    },
    writeResult(result) {
      assert.equal(result?.sourceRevision, sourceRevision, "lifecycle result revision mismatch");
      const line = JSON.stringify(result);
      if (writesCanonicalFiles) {
        writeFileSync(resultPath, `${line}\n`, { encoding: "utf8", flag: "w" });
      }
      writeRawResult(line);
    },
  };
}
