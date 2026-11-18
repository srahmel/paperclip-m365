import { usePluginData } from "@paperclipai/plugin-sdk/ui";

type ScaffoldStatus = {
  status: "ready";
  version: string;
  microsoftIntegration: "not-configured";
};

export function SettingsPage() {
  const { data, loading, error } = usePluginData<ScaffoldStatus>("scaffold-status");

  return (
    <main style={{ display: "grid", gap: "0.75rem", maxWidth: "48rem" }}>
      <h2>Microsoft 365</h2>
      <p>
        The plugin scaffold is installed. Microsoft sign-in and feature access are
        intentionally not part of this work package.
      </p>
      {loading ? <p>Checking worker status...</p> : null}
      {error ? <p>Worker status is unavailable.</p> : null}
      {data ? (
        <dl>
          <dt>Plugin version</dt>
          <dd>{data.version}</dd>
          <dt>Worker status</dt>
          <dd>{data.status}</dd>
          <dt>Microsoft integration</dt>
          <dd>{data.microsoftIntegration}</dd>
        </dl>
      ) : null}
    </main>
  );
}
