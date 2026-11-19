export const governanceTools = [
  { name: "operation-get-result", displayName: "M365 private operation result", description: "Read the bounded resource ID/ETag of your own completed change while retained and still authorized. Never executes or retries a change.",
    parametersSchema: { type: "object" as const, properties: { operationId: { type: "string" as const } }, required: ["operationId"], additionalProperties: false } },
  { name: "operation-get-status", displayName: "M365 operation status", description: "Read the state of your own M365 change request. This never executes or retries a change.",
    parametersSchema: { type: "object" as const, properties: { operationId: { type: "string" as const } }, required: ["operationId"], additionalProperties: false } },
  { name: "connection-get-status", displayName: "M365 connection status", description: "Read connection availability when explicitly assigned to this agent. No account contents or credentials are returned.",
    parametersSchema: { type: "object" as const, properties: { connectionId: { type: "string" as const } }, required: ["connectionId"], additionalProperties: false } },
];
