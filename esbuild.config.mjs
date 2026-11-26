import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const distribution = (options) => ({ ...options, sourcemap: false });

await Promise.all([
  esbuild.build(distribution(presets.esbuild.manifest)),
  esbuild.build(distribution({
    ...presets.esbuild.worker,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  })),
  esbuild.build(distribution(presets.esbuild.ui)),
  esbuild.build({ entryPoints: ["src/telemetry/watchdog.ts"], outfile: "dist/watchdog.js", platform: "node", format: "esm", bundle: true, sourcemap: false, target: "node24" }),
]);
