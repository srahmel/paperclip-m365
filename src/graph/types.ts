import type { Json, OperationType } from "../governance/types.js";

export const JSON_LIMIT = 6 * 1024 * 1024;
export const FILE_LIMIT = 4 * 1024 * 1024;
export interface GraphBinding {
  companyId: string; agentId: string; projectId: string; connectionId: string;
  generation: number; tenantId: string; homeAccountId: string;
}
export interface GraphRequest {
  binding: GraphBinding; operationType: OperationType;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string; query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>; body?: Json | Uint8Array;
  continuation?: string;
}
export interface HttpRequest {
  url: string; method: GraphRequest["method"]; headers: Record<string, string>;
  body?: Uint8Array; maxBytes: number; timeoutMs: number; signal?: AbortSignal;
}
export interface HttpResponse { status: number; headers: Record<string, string | undefined>; body: Uint8Array }
export interface HttpTransport { send(request: HttpRequest): Promise<HttpResponse> }
export type GraphErrorCode = "request_invalid" | "endpoint_denied" | "authority_unavailable" | "aborted" | "timeout" | "network" | "response_invalid" | "size_limit" | "redirect_denied" | "continuation_invalid" | "capacity_exceeded" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "precondition_failed" | "throttled" | "server_error" | "http_error";
export type ContinuationDiagnostic = "next_link_format" | "next_link_origin" | "next_link_path" | "next_link_added_parameter" | "next_link_changed_parameter" | "next_link_duplicate_parameter" | "next_link_missing_parameter";
export class GraphError extends Error {
  constructor(readonly code: GraphErrorCode, readonly status?: number, readonly mutationOutcome: "failed" | "unknown" = "failed", readonly diagnostic?: ContinuationDiagnostic) {
    super(code); this.name = "GraphError";
  }
}
export class HttpFailure extends Error {
  constructor(readonly code: "aborted" | "timeout" | "network" | "size_limit" | "response_invalid" | "endpoint_denied", readonly dispatched: boolean) {
    super(code); this.name = "HttpFailure";
  }
}
export interface GraphResult<T = Json> {
  status: number; data: T | null; complete: boolean; continuation?: string; requestId: string; graphRequestId?: string;
}
export interface GraphSignal {
  operationType: OperationType; statusClass: "2xx" | "3xx" | "4xx" | "5xx" | "timeout" | "network";
  errorClass?: GraphErrorCode; retryAfterSeconds?: number; durationMs: number;
}
