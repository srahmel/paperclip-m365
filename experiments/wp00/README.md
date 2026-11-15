# WP00 contract probe

This experiment exercises the checked-out Paperclip Plugin SDK test harness with only synthetic data. It covers:

- a version-1 manifest and worker setup;
- host-provided tool identity versus spoofable JSON parameters;
- immutable human action context, company scope, and an allowlisted approver;
- the plugin database namespace and capability-gated query/execute calls;
- a deterministic 4-MiB binary payload transported as Base64 JSON and verified by SHA-256.

Run from the repository root on Windows:

```powershell
pwsh -File .\experiments\wp00\run.ps1 -PaperclipSource ..\paperclip
```

The source checkout must have its dependencies installed. The probe imports the SDK source from that checkout so the result is tied to the exact commit and working-tree fingerprint recorded in the architecture decision. It does not install a plugin, contact Microsoft, or use secrets.

When running inside an authenticated Paperclip task, the host gateway checks are reproducible with an existing read-only plugin tool and the current task's project ID:

```powershell
pwsh -NoProfile -File .\experiments\wp00\host-gateway-probe.ps1 `
  -ProjectId '<current-project-uuid>' `
  -ReadOnlyTool 'srahmel.personal-todo:list_tasks'
```

This script requires the injected `PAPERCLIP_*` run environment. It sends four requests that must be rejected before dispatch and one synthetic 4-MiB request to the named read-only tool. It never prints the tool's response content.

The 4-MiB probe intentionally uses the agent-tool/action JSON transport. Its serialized request is below Paperclip's 10-MB global JSON parser limit but above the separate 1,000,000-byte scoped-plugin-API limit. The scoped API is therefore not a version-1 file transport.
