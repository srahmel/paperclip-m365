import { runWorker } from "@paperclipai/plugin-sdk";
import { createM365Plugin } from "./plugin.js";

const plugin = createM365Plugin();

export default plugin;
runWorker(plugin, import.meta.url);
