import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { GovernanceError, type ConnectionPolicy, type GovernanceStore, type OperationRecord } from "./types.js";

type Row = Record<string, unknown>;

export class SqlGovernanceStore implements GovernanceStore {
  readonly #db: PluginDatabaseClient;
  readonly #connections: string;
  readonly #operations: string;
  constructor(db: PluginDatabaseClient) {
    if (!/^[a-z_][a-z0-9_]*$/.test(db.namespace)) throw new GovernanceError("database_namespace_invalid");
    this.#db = db;
    this.#connections = `"${db.namespace}"."connections"`;
    this.#operations = `"${db.namespace}"."operations"`;
  }

  async #query(sql: string, values: unknown[]): Promise<Row[]> {
    try { return await this.#db.query<Row>(sql, values); }
    catch { throw new GovernanceError("storage_unavailable"); }
  }
  async #execute(sql: string, values: unknown[]): Promise<number> {
    try { return (await this.#db.execute(sql, values)).rowCount; }
    catch { throw new GovernanceError("storage_unavailable"); }
  }

  async getPolicy(companyId: string, connectionId: string): Promise<ConnectionPolicy | null> {
    const rows = await this.#query(`SELECT company_id,id,policy_revision,generation,status,shareable,
      policy_bindings,policy_approver_user_ids,tenant_id,home_account_id FROM ${this.#connections} WHERE company_id=$1 AND id=$2`, [companyId, connectionId]);
    const row = rows[0];
    return row ? {
      companyId: String(row.company_id), connectionId: String(row.id), revision: Number(row.policy_revision),
      generation: Number(row.generation), status: String(row.status), shareable: Boolean(row.shareable),
      tenantId: row.tenant_id as string | null, homeAccountId: row.home_account_id as string | null,
      bindings: row.policy_bindings as ConnectionPolicy["bindings"], approverUserIds: row.policy_approver_user_ids as string[],
    } : null;
  }

  async setPolicy(input: Parameters<GovernanceStore["setPolicy"]>[0]): Promise<boolean> {
    return await this.#execute(`UPDATE ${this.#connections} SET policy_revision=policy_revision+1,
      policy_bindings=$4::text::jsonb, policy_approver_user_ids=$5::text::jsonb, policy_changed_by=$6,policy_changed_at=now()
      WHERE company_id=$1 AND id=$2 AND policy_revision=$3
        AND (shareable=TRUE OR jsonb_array_length($4::text::jsonb)<=1)`,
    [input.companyId,input.connectionId,input.expectedRevision,JSON.stringify(input.bindings),JSON.stringify(input.approverUserIds),input.actorId]) === 1;
  }

  #permission(connection: string, operation: string): string {
    const rule = (resource: string) => `${connection}.policy_bindings @> jsonb_build_array(jsonb_build_object(
      'agentId',${operation}.agent_id::text,'rules',jsonb_build_array(jsonb_build_object(
        'operationType',${operation}.operation_type,'resources',jsonb_build_array(${resource})))))`;
    return `(${rule(`${operation}.resource`)} OR ${rule("'*'::text")})`;
  }

  #authority(extra = ""): string {
    return `EXISTS (SELECT 1 FROM ${this.#connections} AS authority
      WHERE authority.company_id=operation.company_id AND authority.id=operation.connection_id
        AND authority.status='connected' AND authority.generation=operation.connection_generation
        AND authority.policy_revision=operation.policy_revision
        AND authority.tenant_id=operation.tenant_id AND authority.home_account_id=operation.home_account_id
        AND ${this.#permission("authority", "operation")} ${extra}
      FOR UPDATE OF authority)`;
  }

  async insertOperation(record: OperationRecord): Promise<boolean> {
    // The supplied state/decision/audit cannot create a pre-approved operation.
    const permission = JSON.stringify([{ agentId: record.agentId, rules: [{ operationType: record.operationType, resources: [record.resource] }] }]);
    const wildcard = JSON.stringify([{ agentId: record.agentId, rules: [{ operationType: record.operationType, resources: ["*"] }] }]);
    return await this.#execute(`INSERT INTO ${this.#operations} (
      company_id,id,connection_id,agent_id,run_id,project_id,operation_type,resource,policy_revision,
      connection_generation,snapshot_hash,snapshot_envelope,expires_at,created_at,state,audit,tenant_id,home_account_id)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12::text::jsonb,$13::timestamptz,$14::timestamptz,'pending',
        jsonb_build_array(jsonb_build_object('state','pending','actorId',$4::text,'at',now(),'correlationId',$2::text)),$17::uuid,$18::text
      FROM ${this.#connections} AS authority
      WHERE authority.company_id=$1 AND authority.id=$3 AND authority.status='connected'
        AND authority.policy_revision=$9 AND authority.generation=$10
        AND authority.tenant_id=$17::uuid AND authority.home_account_id=$18::text
        AND $13::timestamptz>now() AND $12::text::jsonb IS NOT NULL
        AND (authority.policy_bindings @> $15::text::jsonb OR authority.policy_bindings @> $16::text::jsonb)
      FOR UPDATE OF authority`, [record.companyId,record.id,record.connectionId,record.agentId,record.runId,record.projectId,
      record.operationType,record.resource,record.policyRevision,record.connectionGeneration,record.snapshotHash,
      JSON.stringify(record.envelope),record.expiresAt,record.createdAt,permission,wildcard,record.tenantId,record.homeAccountId]) === 1;
  }

  async findOperation(companyId: string, operationId: string): Promise<OperationRecord | null> {
    const rows = await this.#query(`SELECT * FROM ${this.#operations} WHERE company_id=$1 AND id=$2`, [companyId,operationId]);
    return rows[0] ? materialize(rows[0]) : null;
  }
  async listOperations(companyId: string, limit: number): Promise<OperationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GovernanceError("operation_limit_invalid");
    return (await this.#query(`SELECT id,company_id,connection_id,agent_id,run_id,project_id,
      operation_type,resource,policy_revision,connection_generation,tenant_id,home_account_id,
      snapshot_hash,NULL AS snapshot_envelope,expires_at,created_at,state,decision_user_id,decided_at,
      executor_nonce,reserved_at,completed_at,result,audit
      FROM ${this.#operations} WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT $2`, [companyId,limit])).map(materialize);
  }

  async decide(input: Parameters<GovernanceStore["decide"]>[0]): Promise<boolean> {
    const state = input.approve ? "approved" : "rejected";
    return await this.#execute(`UPDATE ${this.#operations} AS operation SET state=$5,decision_user_id=$4,decided_at=now(),
      audit=audit || jsonb_build_array(jsonb_build_object('state',$5::text,'actorId',$4::text,'at',now(),'correlationId',$6::text))
      WHERE company_id=$1 AND id=$2 AND snapshot_hash=$3 AND state='pending' AND expires_at>now()
        AND snapshot_envelope IS NOT NULL AND ${this.#authority("AND authority.policy_approver_user_ids ? $4::text")}`,
    [input.companyId,input.operationId,input.snapshotHash,input.userId,state,input.correlationId]) === 1;
  }

  async reserve(input: Parameters<GovernanceStore["reserve"]>[0]): Promise<boolean> {
    return await this.#execute(`UPDATE ${this.#operations} AS operation SET state='executing',executor_nonce=$4,reserved_at=now(),
      audit=audit || jsonb_build_array(jsonb_build_object('state','executing','actorId','executor','at',now(),'correlationId',$5::text))
      WHERE company_id=$1 AND id=$2 AND snapshot_hash=$3 AND state='approved' AND expires_at>now()
        AND snapshot_envelope IS NOT NULL AND decision_user_id IS NOT NULL
        AND ${this.#authority("AND authority.policy_approver_user_ids ? operation.decision_user_id")}`,
    [input.companyId,input.operationId,input.snapshotHash,input.executorNonce,input.correlationId]) === 1;
  }

  async finish(input: Parameters<GovernanceStore["finish"]>[0]): Promise<boolean> {
    return await this.#execute(`UPDATE ${this.#operations} SET state=$4,result=$5::text::jsonb,completed_at=now(),
      audit=audit || jsonb_build_array(jsonb_build_object('state',$4::text,'actorId','executor','at',now(),'correlationId',$6::text))
      WHERE company_id=$1 AND id=$2 AND state='executing' AND executor_nonce=$3
        AND $4::text IN ('succeeded','failed','unknown')`,
    [input.companyId,input.operationId,input.executorNonce,input.state,JSON.stringify(input.result),input.correlationId]) === 1;
  }

  async recoverUncertain(companyId: string, olderThan: string): Promise<number> {
    return this.#execute(`UPDATE ${this.#operations} SET state='unknown',completed_at=now(),
      audit=audit || jsonb_build_array(jsonb_build_object('state','unknown','actorId','recovery','at',now(),'correlationId',executor_nonce::text))
      WHERE company_id=$1 AND state='executing' AND reserved_at<$2::timestamptz`, [companyId,olderThan]);
  }

  async purgeExpired(companyId: string): Promise<number> {
    return this.#execute(`UPDATE ${this.#operations} SET snapshot_envelope=NULL,
      audit=CASE WHEN state='pending' THEN audit || jsonb_build_array(jsonb_build_object(
        'state','expired','actorId','retention','at',now(),'correlationId',id::text)) ELSE audit END,
      state=CASE WHEN state='pending' THEN 'expired' ELSE state END
      WHERE company_id=$1 AND expires_at<=now() AND snapshot_envelope IS NOT NULL
        AND state<>'executing'`, [companyId]);
  }
}

function materialize(row: Row): OperationRecord {
  const date = (value: unknown) => value === null ? null : new Date(value as string | Date).toISOString();
  return {
    id: String(row.id),companyId: String(row.company_id),connectionId: String(row.connection_id),agentId: String(row.agent_id),
    runId: String(row.run_id),projectId: String(row.project_id),operationType: row.operation_type as OperationRecord["operationType"],
    resource: String(row.resource),policyRevision: Number(row.policy_revision),connectionGeneration: Number(row.connection_generation),
    tenantId: String(row.tenant_id),homeAccountId: String(row.home_account_id),
    snapshotHash: String(row.snapshot_hash),envelope: row.snapshot_envelope as OperationRecord["envelope"],expiresAt: date(row.expires_at)!,
    createdAt: date(row.created_at)!,state: row.state as OperationRecord["state"],decisionUserId: row.decision_user_id as string | null,
    decidedAt: date(row.decided_at),executorNonce: row.executor_nonce as string | null,reservedAt: date(row.reserved_at),
    completedAt: date(row.completed_at),result: row.result as OperationRecord["result"],audit: row.audit as OperationRecord["audit"],
  };
}
