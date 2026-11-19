import type { GraphRequest, GraphResult } from "../graph/types.js";
import type { Json, OperationSnapshot, OperationType } from "../governance/types.js";
import type { GovernanceExecutor } from "../governance/governance-service.js";

/** Internal adapter only: callers cannot supply identity, bearer, URL or headers. */
export interface DomainContext {
  request<T = Json>(resource: string, request: Omit<GraphRequest, "binding">): Promise<GraphResult<T>>;
  download(resource: string, request: Omit<GraphRequest, "binding">): Promise<Uint8Array>;
  assertCurrent(): Promise<void>;
}
export interface PreparedChange { operationType: OperationType; resource: string; payload: Json }
export interface DomainToolDeclaration {
  name: string; displayName: string; description: string;
  parametersSchema: Record<string, unknown>;
}
export interface DomainModule {
  tools: DomainToolDeclaration[];
  read(name: string, input: Record<string, unknown>, context: DomainContext): Promise<Json>;
  prepare(name: string, input: Record<string, unknown>, context: DomainContext): Promise<PreparedChange>;
  execute(snapshot: Readonly<OperationSnapshot>, context: DomainContext): ReturnType<GovernanceExecutor>;
}
