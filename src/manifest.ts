import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { governanceTools } from "./governance/tool-declarations.js";
import { domainTools } from "./domains/index.js";

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
    "metrics.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "projects.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  tools: [...governanceTools, ...domainTools],
  jobs: [{ jobKey: "operation-retention", displayName: "M365 operation retention",
    description: "Clear expired encrypted requests and quarantine stale execution reservations without retrying them.", schedule: "*/5 * * * *" },
    { jobKey: "telemetry-evaluate", displayName: "M365 operational monitoring", description: "Evaluate content-free operational signals and the durable alarm outbox.", schedule: "* * * * *" }],
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
