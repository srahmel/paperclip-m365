import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, "dist");

if (basename(outputPath) !== "dist" || dirname(outputPath) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${outputPath}`);
}

await rm(outputPath, { recursive: true, force: true });
