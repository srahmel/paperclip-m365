import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GovernancePanel } from "../src/ui/governance-panel.js";
import { Fixture } from "./ui-preview-sdk.jsx";
import { browserCanonicalJson } from "../src/ui/operation-preview-model.js";

const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const connectionId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
function App() {
  const [companyId, setCompany] = useState(companyA), [denied, setDenied] = useState(false), [state, setState] = useState("pending"), [executions, setExecutions] = useState(0);
  const [revision, setRevision] = useState(1), [saved, setSaved] = useState(null);
  const expiresAt = new Date(Date.now() + 900000).toISOString();
  const operation = { id: "33333333-3333-4333-8333-333333333333", companyId, connectionId, agentId, operationType: "mail-send", resource: "mailbox:self", state,
    expiresAt, decisionUserId: state === "pending" ? null : "synthetic-human", decidedAt: state === "pending" ? null : new Date().toISOString(),
    result: state === "succeeded" ? { schemaVersion: 1, code: "accepted", resourceKind: "mail", errorCode: null } : null };
  const policy = { companyId, connectionId, revision, generation: 1, status: "connected", shareable: true, tenantId: "synthetic-tenant", homeAccountId: "synthetic-account",
    bindings: saved?.bindings ?? [{ agentId, rules: [{ operationType: "mail-send", resources: ["mailbox:self"] }] }], approverUserIds: saved?.approverUserIds ?? ["synthetic-human"] };
  const snapshot = { schemaVersion: 1, companyId, agentId, connectionId, runId: "synthetic-run", projectId: "synthetic-project", operationType: "mail-send", resource: "mailbox:self",
    policyRevision: revision, connectionGeneration: 1, expiresAt, tenantId: "synthetic-tenant", homeAccountId: "synthetic-account",
    payload: { version: 1, message: { subject: "Synthetische Freigabe", body: { contentType: "Text", content: 'Nur Testdaten. <script>alert("untrusted")</script> bleibt sichtbarer Text.' },
      toRecipients: [{ emailAddress: { address: "test@example.test" } }], ccRecipients: [], bccRecipients: [{ emailAddress: { address: "bcc@example.test" } }],
      attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "synthetic.bin", contentType: "application/octet-stream", contentBytes: "AAEC" }] },
      attachmentHashes: ["ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc"] } };
  async function action(name, parameters) {
    if (denied) throw new Error("synthetic_permission_denied");
    if (name === "policy-get") return policy;
    if (name === "policy-set") { setSaved(parameters); setRevision(revision + 1); return { ...policy, ...parameters, revision: revision + 1 }; }
    if (name === "operation-list") return companyId === companyA ? [operation] : [];
    if (name === "operation-preview") {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserCanonicalJson(snapshot))))).map(byte => byte.toString(16).padStart(2, "0")).join("");
      return { operation, snapshot, snapshotHash: hash };
    }
    if (name === "operation-decide") { const next = parameters.approve ? "approved" : "rejected"; setState(next); return { ...operation, state: next, decisionUserId: "synthetic-human", decidedAt: new Date().toISOString() }; }
    if (name === "operation-invalidate") { setState("invalidated"); return { ...operation, state: "invalidated" }; }
    if (name === "operation-execute") { if (state !== "approved") throw new Error("synthetic_cas_rejected"); setState("succeeded"); setExecutions(value => value + 1); return { ...operation, state: "succeeded", result: { schemaVersion: 1, code: "accepted", resourceKind: "mail", errorCode: null } }; }
    throw new Error("synthetic_action_unsupported");
  }
  return <Fixture.Provider value={{ action }}><h1>M365 – synthetische Browserprüfung</h1><p>Simulierte Actions, keine Verbindung zu Microsoft oder Paperclip. Kein Versand.</p>
    <nav aria-label="Testszenario"><button onClick={() => setCompany(companyId === companyA ? companyB : companyA)}>Unternehmen wechseln</button><button onClick={() => setDenied(!denied)}>Zugriff {denied ? "erlauben" : "verweigern"}</button><button onClick={() => setState("unknown")}>Unbekannten Ausgang simulieren</button></nav>
    <p role="status">Unternehmen {companyId === companyA ? "A" : "B"}; simulierte Ausführungen: {executions}; Zugriff: {denied ? "verweigert" : "erlaubt"}</p>
    <GovernancePanel key={companyId} companyId={companyId} connectionId={connectionId} locale="de" /></Fixture.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
