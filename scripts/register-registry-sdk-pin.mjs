import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const registryRoot = process.env.PAPERCLIP_REGISTRY_ROOT;
assert(registryRoot, "PAPERCLIP_REGISTRY_ROOT is required");

const packageName = "@paperclipai/plugin-sdk";
const packageRoot = resolve(registryRoot, "node_modules", packageName);
const packageManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
assert.equal(packageManifest.version, "2026.1106.0", "unexpected registry SDK version");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) {
      return nextResolve(specifier, context);
    }

    const exportKey = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
    const declaration = packageManifest.exports?.[exportKey];
    const relativeTarget = typeof declaration === "string" ? declaration : declaration?.import;
    assert(relativeTarget, `registry SDK does not export ${exportKey}`);

    return {
      url: pathToFileURL(resolve(packageRoot, relativeTarget)).href,
      shortCircuit: true,
    };
  },
});
