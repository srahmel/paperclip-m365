import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const distribution = (options) => ({ ...options, sourcemap: false });

await Promise.all([
  esbuild.build(distribution(presets.esbuild.manifest)),
  esbuild.build(distribution({
    ...presets.esbuild.worker,
    external: [...presets.esbuild.worker.external, "@azure/msal-node"],
  })),
  esbuild.build(distribution(presets.esbuild.ui)),
]);
