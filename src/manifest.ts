import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { governanceTools } from "./governance/tool-declarations.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "srahmel.m365",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Microsoft 365",
  description: "Paperclip plugin scaffold for Microsoft 365",
  author: "Encurio GmbH",
  categories: ["connector", "ui"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "secrets.read-ref",
    "instance.settings.register",
    "access.members.read",
    "agents.read",
    "agent.tools.register",
    "jobs.schedule",
  ],
  tools: governanceTools,
  jobs: [{ jobKey: "operation-retention", displayName: "M365 operation retention",
    description: "Clear expired encrypted requests and quarantine stale execution reservations without retrying them.", schedule: "*/5 * * * *" }],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "m365",
    migrationsDir: "migrations",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Microsoft 365",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
