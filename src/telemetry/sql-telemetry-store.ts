import { createHash, randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { TelemetryError, type TelemetryStore, type MetricBucket, type MetricBucketDelta, type InventorySample, type DailyBaseline, type RuleState, type Incident } from "./types.js";
import { validateLabels } from "./policy.js";

type Row = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value);
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

/** All mutations use one host-supported statement; no transaction/CTE API is assumed. */
export class SqlTelemetryStore implements TelemetryStore {
  readonly #db: PluginDatabaseClient;
  readonly #companies: string;
  readonly #buckets: string;
  readonly #days: string;
  constructor(db: PluginDatabaseClient) {
    if (!/^[a-z_][a-z0-9_]*$/.test(db.namespace)) throw new TelemetryError("storage_unavailable");
    this.#db = db;
    this.#companies = `"${db.namespace}"."telemetry_companies"`;
    this.#buckets = `"${db.namespace}"."telemetry_buckets"`;
    this.#days = `"${db.namespace}"."telemetry_days"`;
  }
  async #query(statement: string, params: unknown[]): Promise<Row[]> {
    try { return await this.#db.query<Row>(statement, params); }
    catch { throw new TelemetryError("storage_unavailable"); }
  }
  async #execute(statement: string, params: unknown[]): Promise<number> {
    try { return (await this.#db.execute(statement, params)).rowCount; }
    catch { throw new TelemetryError("storage_unavailable"); }
  }
  async #ensure(companyId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw new TelemetryError("scope_invalid");
    await this.#execute(`INSERT INTO ${this.#companies}(company_id) VALUES($1) ON CONFLICT(company_id) DO NOTHING`, [companyId]);
  }
  async addBuckets(companyId: string, buckets: MetricBucketDelta[]) {
    if (buckets.length === 0) return;
    if (buckets.length > 32) throw new TelemetryError("capacity_exceeded");
    const grouped = new Map<string, MetricBucketDelta>();
    for (const bucket of buckets) {
      validateLabels(bucket.metric, bucket.labels);
      if (!Number.isFinite(Date.parse(bucket.minute)) || !Number.isSafeInteger(bucket.count) || bucket.count < 0 ||
        !Number.isFinite(bucket.sum) || bucket.sum < 0 || !Number.isFinite(bucket.max) || bucket.max < 0 ||
        bucket.histogram.length !== 4 || bucket.histogram.some((count, index) => !Number.isSafeInteger(count) || count < 0 || count > bucket.count || index > 0 && count < bucket.histogram[index - 1]!)) {
        throw new TelemetryError("telemetry_data_invalid");
      }
      const labels = Object.fromEntries(Object.entries(bucket.labels).sort(([a], [b]) => a.localeCompare(b)));
      const key = `${bucket.minute}:${bucket.metric}:${json(labels)}`;
      const old = grouped.get(key);
      if (old) {
        old.count += bucket.count; old.sum += bucket.sum; old.max = Math.max(old.max, bucket.max);
        old.histogram = old.histogram.map((value, index) => value + bucket.histogram[index]!);
      } else grouped.set(key, { ...bucket, labels, histogram: [...bucket.histogram] });
    }
    await this.#ensure(companyId);
    const params: unknown[] = [];
    const values = [...grouped.values()].map((bucket) => {
      const offset = params.length;
      const labels = json(bucket.labels);
      params.push(companyId, bucket.minute, bucket.metric, createHash("sha256").update(labels).digest("hex"), labels,
        bucket.count, bucket.sum, bucket.max, ...bucket.histogram);
      return `(${Array.from({ length: 12 }, (_, i) => `$${offset + i + 1}${i === 4 ? "::text::jsonb" : ""}`).join(",")})`;
    });
    await this.#execute(`INSERT INTO ${this.#buckets} AS current
      (company_id,minute,metric,labels_key,labels,sample_count,sample_sum,sample_max,h0,h1,h2,h3)
      VALUES ${values.join(",")}
      ON CONFLICT(company_id,minute,metric,labels_key) DO UPDATE SET
      sample_count=current.sample_count+excluded.sample_count,sample_sum=current.sample_sum+excluded.sample_sum,
      sample_max=GREATEST(current.sample_max,excluded.sample_max),h0=current.h0+excluded.h0,
      h1=current.h1+excluded.h1,h2=current.h2+excluded.h2,h3=current.h3+excluded.h3`, params);
  }
  async readBuckets(companyId: string, sinceIso: string): Promise<MetricBucket[]> {
    const rows = await this.#query(`SELECT * FROM ${this.#buckets} WHERE company_id=$1 AND minute>=$2::timestamptz ORDER BY minute,metric,labels_key LIMIT 40001`, [companyId, sinceIso]);
    if (rows.length > 40_000) throw new TelemetryError("capacity_exceeded");
    return rows.map((row) => ({ minute: iso(row.minute), metric: row.metric as MetricBucket["metric"], labels: row.labels as MetricBucket["labels"],
      count: Number(row.sample_count), sum: Number(row.sample_sum), max: Number(row.sample_max), histogram: [row.h0, row.h1, row.h2, row.h3].map(Number) }));
  }
  async putInventory(companyId: string, sample: InventorySample) {
    await this.#ensure(companyId);
    await this.#execute(`UPDATE ${this.#companies} SET inventory=$2::text::jsonb
      WHERE company_id=$1 AND (inventory IS NULL OR (inventory->>'at')::timestamptz<=$3::timestamptz)`, [companyId, json(sample), sample.at]);
  }
  async getInventory(companyId: string): Promise<InventorySample | null> {
    return (await this.#query(`SELECT inventory FROM ${this.#companies} WHERE company_id=$1`, [companyId]))[0]?.inventory as InventorySample | null ?? null;
  }
  async putDailyBaseline(companyId: string, baseline: DailyBaseline) {
    await this.#ensure(companyId);
    await this.#execute(`INSERT INTO ${this.#days}(company_id,day,operations,audit_events) VALUES($1,$2::date,$3,$4)
      ON CONFLICT(company_id,day) DO UPDATE SET operations=excluded.operations,audit_events=excluded.audit_events`,
    [companyId, baseline.day, baseline.operations, baseline.auditEvents]);
  }
  async listDailyBaselines(companyId: string, sinceDayIso: string): Promise<DailyBaseline[]> {
    return (await this.#query(`SELECT day,operations,audit_events FROM ${this.#days} WHERE company_id=$1 AND day>=$2::date ORDER BY day LIMIT 9`, [companyId, sinceDayIso]))
      .map((row) => ({ day: iso(row.day).slice(0, 10), operations: Number(row.operations), auditEvents: Number(row.audit_events) }));
  }
  async getRuleStates(companyId: string): Promise<{ revision: number; states: RuleState[] }> {
    const row = (await this.#query(`SELECT rule_revision,rule_states FROM ${this.#companies} WHERE company_id=$1`, [companyId]))[0];
    return { revision: Number(row?.rule_revision ?? 0), states: row?.rule_states as RuleState[] ?? [] };
  }
  async saveRuleStates(companyId: string, expectedRevision: number, states: RuleState[], incidents: Incident[] = []): Promise<boolean> {
    if (states.length > 1024 || incidents.length > 256) throw new TelemetryError("capacity_exceeded");
    if (new Set(incidents.map((incident) => incident.episodeKey)).size !== incidents.length) throw new TelemetryError("input_invalid");
    await this.#ensure(companyId);
    const unseen = `SELECT candidate FROM jsonb_array_elements($4::text::jsonb) AS candidate
      WHERE NOT company.incidents @> jsonb_build_array(jsonb_build_object('episodeKey',candidate->>'episodeKey'))`;
    return await this.#execute(`UPDATE ${this.#companies} AS company SET rule_states=$3::text::jsonb,rule_revision=rule_revision+1,
      incidents=company.incidents || COALESCE((SELECT jsonb_agg(candidate) FROM (${unseen}) AS incoming(candidate)), '[]'::jsonb)
      WHERE company_id=$1 AND rule_revision=$2
        AND jsonb_array_length(company.incidents)+(SELECT count(*) FROM (${unseen}) AS incoming(candidate))<=256`,
    [companyId, expectedRevision, json(states), json(incidents)]) === 1;
  }
  async ensureIncident(companyId: string, incident: Incident): Promise<"created" | "exists" | "capacity"> {
    await this.#ensure(companyId);
    const changed = await this.#execute(`UPDATE ${this.#companies} SET incidents=incidents || $3::text::jsonb
      WHERE company_id=$1 AND NOT incidents @> $2::text::jsonb AND jsonb_array_length(incidents)<256`,
    [companyId, json([{ episodeKey: incident.episodeKey }]), json([incident])]);
    if (changed === 1) return "created";
    return (await this.listIncidents(companyId, 256)).some((item) => item.episodeKey === incident.episodeKey) ? "exists" : "capacity";
  }
  async listIncidents(companyId: string, limit: number): Promise<Incident[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new TelemetryError("input_invalid");
    const row = (await this.#query(`SELECT incidents FROM ${this.#companies} WHERE company_id=$1`, [companyId]))[0];
    return [...(row?.incidents as Incident[] ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async #incidentSlot(companyId: string, id: string): Promise<{ index: number; incident: Incident } | null> {
    const row = (await this.#query(`SELECT incidents FROM ${this.#companies} WHERE company_id=$1`, [companyId]))[0];
    const items = row?.incidents as Incident[] ?? [];
    const index = items.findIndex((item) => item.id === id);
    return index < 0 ? null : { index, incident: items[index]! };
  }
  async claimDelivery(companyId: string, id: string, nowIso: string): Promise<Incident | null> {
    const slot = await this.#incidentSlot(companyId, id);
    if (!slot) return null;
    const nonce = randomUUID();
    const stale = new Date(Date.parse(nowIso) - 60_000).toISOString();
    // A crashed final delivery remains exhausted; it is never replayed beyond the bound.
    await this.#execute(`UPDATE ${this.#companies} SET incidents=jsonb_set(incidents,ARRAY[$2::text],
      incidents->$2::int || '{"deliveryState":"exhausted"}'::jsonb)
      WHERE company_id=$1 AND incidents->$2::int->>'id'=$3 AND incidents->$2::int->>'deliveryState'='delivering'
      AND (incidents->$2::int->>'attempts')::int>=3 AND (incidents->$2::int->>'deliveryClaimedAt')::timestamptz<=$4::timestamptz`, [companyId, slot.index, id, stale]);
    const patch = { deliveryState: "delivering", deliveryNonce: nonce, deliveryClaimedAt: nowIso };
    const count = await this.#execute(`UPDATE ${this.#companies} SET incidents=jsonb_set(incidents,ARRAY[$2::text],
      incidents->$2::int || $4::text::jsonb || jsonb_build_object('attempts',((incidents->$2::int->>'attempts')::int)+1))
      WHERE company_id=$1 AND incidents->$2::int->>'id'=$3 AND (incidents->$2::int->>'attempts')::int<3
      AND ((incidents->$2::int->>'deliveryState'='pending' AND (incidents->$2::int->>'nextAttemptAt' IS NULL OR (incidents->$2::int->>'nextAttemptAt')::timestamptz<=$5::timestamptz))
        OR (incidents->$2::int->>'deliveryState'='delivering' AND (incidents->$2::int->>'deliveryClaimedAt')::timestamptz<=$6::timestamptz))`,
    [companyId, slot.index, id, json(patch), nowIso, stale]);
    if (count !== 1) return null;
    const current = await this.#incidentSlot(companyId, id);
    return current?.incident.deliveryNonce === nonce ? current.incident : null;
  }
  async finishDelivery(companyId: string, id: string, input: Parameters<TelemetryStore["finishDelivery"]>[2]): Promise<boolean> {
    const slot = await this.#incidentSlot(companyId, id);
    if (!slot) return false;
    return await this.#execute(`UPDATE ${this.#companies} SET incidents=jsonb_set(incidents,ARRAY[$2::text],incidents->$2::int || $5::text::jsonb)
      WHERE company_id=$1 AND incidents->$2::int->>'id'=$3 AND incidents->$2::int->>'deliveryState'='delivering' AND incidents->$2::int->>'deliveryNonce'=$4`,
    [companyId, slot.index, id, input.deliveryNonce, json({ deliveryState: input.state, receipt: input.receipt, nextAttemptAt: input.nextAttemptAt })]) === 1;
  }
  async acknowledge(companyId: string, id: string, input: Parameters<TelemetryStore["acknowledge"]>[2]): Promise<boolean> {
    const slot = await this.#incidentSlot(companyId, id);
    if (!slot) return false;
    return await this.#execute(`UPDATE ${this.#companies} SET incidents=jsonb_set(incidents,ARRAY[$2::text],incidents->$2::int || $4::text::jsonb)
      WHERE company_id=$1 AND incidents->$2::int->>'id'=$3 AND incidents->$2::int->>'deliveryState'='delivered'
      AND incidents->$2::int->>'receipt' IS NOT NULL AND incidents->$2::int->>'acknowledgedAt' IS NULL AND incidents->$2::int->>'runbookStep'=$5`,
    [companyId, slot.index, id, json({ acknowledgedAt: input.at, acknowledgedBy: input.actorId, acknowledgedStep: input.runbookStep }), input.runbookStep]) === 1;
  }
  async prune(companyId: string, beforeMinuteIso: string, beforeDayIso: string) {
    await this.#execute(`DELETE FROM ${this.#buckets} WHERE company_id=$1 AND minute<$2::timestamptz`, [companyId, beforeMinuteIso]);
    await this.#execute(`DELETE FROM ${this.#days} WHERE company_id=$1 AND day<$2::date`, [companyId, beforeDayIso]);
    // Keep every unacknowledged incident and every ongoing episode; never silently evict work.
    await this.#execute(`UPDATE ${this.#companies} AS company SET incidents=COALESCE((SELECT jsonb_agg(item ORDER BY ordinal)
      FROM jsonb_array_elements(company.incidents) WITH ORDINALITY AS entry(item,ordinal)
      WHERE item->>'acknowledgedAt' IS NULL OR (item->>'acknowledgedAt')::timestamptz>=$2::timestamptz
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(company.rule_states) AS rule
          WHERE rule->>'key'=item->>'ruleKey' AND rule->>'conditionSince' IS NOT NULL)), '[]'::jsonb)
      WHERE company_id=$1`, [companyId, beforeMinuteIso]);
  }
}
