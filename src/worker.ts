import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("scaffold-status", async () => ({
      status: "ready" as const,
      version: manifest.version,
      microsoftIntegration: "not-configured" as const,
    }));
  },

  async onHealth() {
    return {
      status: "ok" as const,
      message: "M365 plugin scaffold is ready",
    };
  },

  async onIdleDrain() {
    return "none";
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
