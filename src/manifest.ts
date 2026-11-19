import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

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
  ],
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
