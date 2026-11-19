# WP10 authenticated agent boundary

The integration script is an isolated-CI candidate, not a locally executed live-host check. It uses the actual packaged M365 worker, pinned Paperclip host handlers, HTTP JWT authentication, database-backed gateway policy and plugin authorization. No TestHarness or fake dispatcher replaces this path.

Required environment: PAPERCLIP_SOURCE at d69631b01b9c658f80bf8bed389863dce82643e1; existing PAPERCLIP_PACKAGE_ROOT, PAPERCLIP_PACKAGE_ARCHIVE, PAPERCLIP_PACKAGE_MANIFEST, PAPERCLIP_SOURCE_REVISION; and PAPERCLIP_AGENT_GATEWAY_DATABASE_URL. The latter must use loopback and fresh database paperclip_m365_agent_gateway. CI creates and drops that database inside its disposable PostgreSQL service. There is no production database fallback.

Run with the existing pinned host tsx loader:

```text
node --import <resolved-pinned-host-tsx-loader> tests/host-agent-gateway.integration.mjs
```

The SDK must already be built. Keep the test and child worker in the existing offline CI isolation. A five-minute watchdog and 30-second HTTP deadlines bound failures. No Microsoft call is needed: the read-only connection-get-status tool reads only the synthetic plugin connection assignment.

Fixture: verified artifact installation and migrations; synthetic company, project, idle agent and running heartbeat record; exact include entry in a deny-by-default tool profile; real plugin worker/host services; signed ephemeral agent JWT; actorMiddleware in authenticated mode; actual pluginRoutes and tool gateway. No JWT or signing key is emitted in the receipt.

Assertions: one allowed status result and persisted succeeded host invocation; one host policy denial; one plugin policy denial; four forged run-context denials; invalid JWT denial; inactive-run denial. A wrapper counts actual worker executeTool calls without replacing behavior: exactly two (allowed and plugin-denied). The authenticated actor must be agent_jwt. After cleanup, the actual child handle is stopped, the HTTP listener closed and the closed database client rejects further queries.

The final receipt begins with probe=wp10-authenticated-agent-gateway and contains:

```json
{"probe":"wp10-authenticated-agent-gateway","check":"isolated-authenticated-agent-gateway","status":"pass","hostRevision":"d69631b01b9c658f80bf8bed389863dce82643e1","currentSourceRevision":"<verified-plugin-commit>","packageSha256":"<verified-package-sha256>","pluginWorker":"actual-package-worker","authentication":"signed-agent-jwt-http","gateway":"actual-host-policy-and-postgres","allowed":1,"hostDenied":1,"pluginDenied":1,"spoofedContextsDenied":4,"invalidJwtDenied":1,"inactiveRunDenied":1,"workerDispatches":2,"microsoftCalls":0,"scope":"synthetic-run-record-not-llm-adapter-run","cleanup":{"workerStopped":true,"httpClosed":true,"databaseClosed":true}}
```

Revision and hash come from verifyArtifactFile with the supported install phase. Accept the receipt only with exit code zero; earlier host logs are not completion evidence.

This validates HTTP authentication, active-run records, gateway policy, actual worker RPC and plugin policy using synthetic records. It does not start an LLM adapter, validate Microsoft scopes, access an actual Microsoft account or prove production behavior. Those remain separate WP10 evidence.
