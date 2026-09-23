import { createHash, randomUUID } from 'node:crypto';

import type {
  HealthJobQueue,
  HealthSystem,
  TriageJobQueue,
  TriageSystem,
  TransactionalDatabase,
} from '@incident-command-center/application';
import {
  DeploymentEventIngestionResultSchema,
  CustomerReportIngestionResultSchema,
  EvidenceLinkSchema,
  ActionAttemptSchema,
  AssignmentRequestSchema,
  CorroboratingFactSchema,
  EvaluationSchema,
  ReviewTaskSchema,
  HumanOverrideSchema,
  HealthCheckJobSchema,
  HealthCheckMessageV1Schema,
  IncidentDetailSchema,
  IncidentSchema,
  MonitoringAlertIngestionResultSchema,
  PageRequestSchema,
  PolicyDecisionSchema,
  SignalSchema,
  TriageCaseDetailSchema,
  TriageCaseSchema,
  TriageJobMessageV1Schema,
  TimelineEventSchema,
  WorkflowActionSchema,
  WorkflowActionDefinitionSchema,
  WorkflowActionJobMessageV1Schema,
  type AssignmentRequest,
  type HealthCheckJob,
  type HealthCheckMessageV1,
  type HealthStatus,
  type DeploymentEventIngestionResult,
  type DeploymentEventInput,
  type CustomerReportIngestionResult,
  type CustomerReportInput,
  type EvidenceLink,
  type CorroboratingFact,
  type Evaluation,
  type EvaluationInput,
  type Incident,
  type IncidentDetail,
  type MonitoringAlertIngestionResult,
  type MonitoringAlertInput,
  type OperationalJudgments,
  type PageRequest,
  type PolicyDecision,
  type Signal,
  type TriageCase,
  type TriageCaseDetail,
  type TriageJobMessageV1,
  type ReviewQueue,
  type ReviewCommand,
  type PriorityOverrideCommand,
  type TimelineEvent,
  type WorkflowAction,
  type WorkflowActionDefinition,
  type WorkflowActionJobMessageV1,
} from '@incident-command-center/contracts';
import {
  decideAutomation,
  decideIncidentRelationship,
  evaluateDeploymentEventDeterministically,
  evaluateCustomerReportDeterministically,
  evaluateMonitoringAlertDeterministically,
  NORTHSTAR_SERVICE_DOMAINS,
  reviewUrgency,
  WorkflowProviderError,
  type AssignmentProviderPort,
  type Clock,
  type OperationalJudgmentProviderPort,
  type OperationalJudgmentResult,
  type PagingProviderPort,
} from '@incident-command-center/domain';
import type { Pool, PoolClient } from 'pg';
import { Pool as PostgresPool } from 'pg';
import { PgBoss, type Db } from 'pg-boss';
import { JevEvaluationFailure, JEV_QUESTION_SET_VERSION } from './jev.js';

export {
  buildJevRequest,
  JevOperationalJudgmentProvider,
  LiveJevTransport,
  RecordedJevTransport,
  JEV_MODEL,
  JEV_QUESTION_SET_VERSION,
} from './jev.js';

export const HEALTH_CHECK_QUEUE = 'system-health-check';
export const TRIAGE_QUEUE = 'triage-case-processing';
export class ReviewConflictError extends Error {}
export class ReviewTargetNotFoundError extends Error {}
const WORKER_READY_WINDOW_MS = 15_000;
const APPLICATION_SCHEMA_LOCK = 740_219_350;
const TRIAGE_MATCH_LOCK = 740_219_351;

function workflowActionId(key: string): string {
  const bytes = createHash('sha1').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface HealthJobRow {
  id: string;
  status: 'queued' | 'completed';
  correlation_id: string;
  requested_at: Date;
  completed_at: Date | null;
  result: unknown | null;
}

interface SignalRow {
  id: string;
  source_type: 'monitoring_alert' | 'deployment_event' | 'customer_report';
  provider: string;
  source_event_key: string;
  source_reference: string;
  occurred_at: Date;
  received_at: Date;
  service: string;
  environment: string | null;
  region: string | null;
  title: string | null;
  content: string | null;
  facts: unknown;
  normalization_version: 1;
  raw_fixture_reference: string | null;
  correlation_id: string;
}

interface TriageCaseRow {
  id: string;
  signal_id: string;
  status:
    | 'queued'
    | 'ready_for_evaluation'
    | 'incident_created'
    | 'needs_review'
    | 'evidence_linked'
    | 'dismissed';
  source_reference: string;
  service: string;
  region: string | null;
  received_at: Date;
  correlation_id: string;
}

interface NormalizedSignalDraft {
  sourceType: SignalRow['source_type'];
  provider: string;
  sourceEventKey: string;
  sourceReference: string;
  occurredAt: string | null;
  service: string;
  environment: string | null;
  region: string | null;
  title: string | null;
  content: string | null;
  facts: unknown;
  rawFixtureReference: string | null;
}

const schemaSql = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE IF NOT EXISTS health_check_jobs (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('queued', 'completed')),
    correlation_id uuid NOT NULL,
    requested_at timestamptz NOT NULL,
    completed_at timestamptz,
    result jsonb
  );

  CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_name text PRIMARY KEY,
    observed_at timestamptz NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signals (
    id uuid PRIMARY KEY,
    source_type text NOT NULL CHECK (source_type IN ('monitoring_alert', 'deployment_event', 'customer_report')),
    provider text NOT NULL,
    source_event_key text NOT NULL,
    source_reference text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    service text NOT NULL,
    environment text,
    region text,
    title text,
    content text,
    facts jsonb NOT NULL,
    normalization_version integer NOT NULL,
    raw_fixture_reference text,
    correlation_id uuid NOT NULL,
    UNIQUE (provider, source_event_key)
  );

  CREATE TABLE IF NOT EXISTS triage_cases (
    id uuid PRIMARY KEY,
    signal_id uuid NOT NULL UNIQUE REFERENCES signals(id),
    status text NOT NULL CHECK (status IN ('queued', 'ready_for_evaluation')),
    source_reference text NOT NULL,
    service text NOT NULL,
    region text,
    received_at timestamptz NOT NULL,
    correlation_id uuid NOT NULL
  );

  ALTER TABLE signals ALTER COLUMN title DROP NOT NULL;
  ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_source_type_check;
  ALTER TABLE signals ADD CONSTRAINT signals_source_type_check
    CHECK (source_type IN ('monitoring_alert', 'deployment_event', 'customer_report'));
  ALTER TABLE triage_cases DROP CONSTRAINT IF EXISTS triage_cases_status_check;
  ALTER TABLE triage_cases ADD CONSTRAINT triage_cases_status_check
    CHECK (status IN ('queued', 'ready_for_evaluation', 'incident_created', 'needs_review', 'evidence_linked', 'dismissed'));

  CREATE INDEX IF NOT EXISTS signals_service_region_occurred
    ON signals (service, region, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS evaluations (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS review_tasks (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL UNIQUE REFERENCES triage_cases(id),
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS corroborating_facts (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy_decisions (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL UNIQUE REFERENCES triage_cases(id),
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS human_overrides (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    incident_id uuid REFERENCES incidents(id),
    record jsonb NOT NULL
  );

  CREATE INDEX IF NOT EXISTS incidents_title_search
    ON incidents USING gin (to_tsvector('english', coalesce(record->>'title', '')));
  CREATE INDEX IF NOT EXISTS incidents_title_trigram
    ON incidents USING gin ((record->>'title') gin_trgm_ops);

  CREATE TABLE IF NOT EXISTS evidence_links (
    id uuid PRIMARY KEY,
    incident_id uuid NOT NULL REFERENCES incidents(id),
    signal_id uuid NOT NULL UNIQUE REFERENCES signals(id),
    triage_case_id uuid NOT NULL UNIQUE REFERENCES triage_cases(id),
    evaluation_id uuid NOT NULL REFERENCES evaluations(id),
    policy_decision_id uuid REFERENCES policy_decisions(id),
    record jsonb NOT NULL
  );
  ALTER TABLE evidence_links ALTER COLUMN policy_decision_id DROP NOT NULL;
  CREATE INDEX IF NOT EXISTS evidence_links_incident_id ON evidence_links (incident_id);

  CREATE TABLE IF NOT EXISTS workflow_actions (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    incident_id uuid REFERENCES incidents(id),
    idempotency_key text NOT NULL UNIQUE,
    record jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_attempts (
    id uuid PRIMARY KEY,
    action_id uuid NOT NULL REFERENCES workflow_actions(id),
    sequence integer NOT NULL,
    record jsonb NOT NULL
  );

  CREATE INDEX IF NOT EXISTS action_attempts_action_sequence
    ON action_attempts (action_id, sequence);

  CREATE TABLE IF NOT EXISTS effects_ledger (
    idempotency_key text PRIMARY KEY,
    action_id uuid NOT NULL UNIQUE REFERENCES workflow_actions(id),
    status text NOT NULL CHECK (status IN
      ('pending', 'executing', 'retry_scheduled', 'succeeded', 'permanently_failed')),
    provider_reference text,
    next_retry_at timestamptz,
    suppressed_count integer NOT NULL DEFAULT 0,
    failure_reason text,
    claimed_at timestamptz,
    claim_token uuid
  );

  ALTER TABLE effects_ledger ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
  ALTER TABLE effects_ledger ADD COLUMN IF NOT EXISTS suppressed_count integer NOT NULL DEFAULT 0;
  ALTER TABLE effects_ledger ADD COLUMN IF NOT EXISTS failure_reason text;

  INSERT INTO effects_ledger (idempotency_key, action_id, status,
    provider_reference, next_retry_at, suppressed_count, failure_reason)
  SELECT w.idempotency_key, w.id, w.record->>'status',
    w.record->>'providerReference',
    (w.record->>'nextRetryAt')::timestamptz,
    COALESCE((w.record->>'suppressedCount')::integer, 0),
    w.record->>'failureReason'
  FROM workflow_actions w
  WHERE w.record ? 'status'
  ON CONFLICT (idempotency_key) DO NOTHING;

  UPDATE effects_ledger l SET
    next_retry_at = (w.record->>'nextRetryAt')::timestamptz,
    suppressed_count = COALESCE((w.record->>'suppressedCount')::integer, 0),
    failure_reason = w.record->>'failureReason'
  FROM workflow_actions w
  WHERE l.action_id = w.id AND w.record ? 'status';

  INSERT INTO action_attempts (id, action_id, sequence, record)
  SELECT (attempt.value->>'id')::uuid, w.id, attempt.ordinality::integer,
    jsonb_build_object(
      'id', attempt.value->>'id',
      'sequence', attempt.ordinality,
      'attemptedAt', attempt.value->>'attemptedAt',
      'outcome', attempt.value->>'outcome',
      'providerReference', attempt.value->'providerReference',
      'detail', NULL
    )
  FROM workflow_actions w,
    LATERAL jsonb_array_elements(COALESCE(w.record->'attempts', '[]'::jsonb))
      WITH ORDINALITY AS attempt(value, ordinality)
  WHERE w.record ? 'status'
  ON CONFLICT (id) DO NOTHING;

  UPDATE workflow_actions w SET record = jsonb_build_object(
    'id', w.id,
    'correlationId', w.record->>'correlationId',
    'policyDecisionId', COALESCE(w.record->>'policyDecisionId',
      (SELECT p.id::text FROM policy_decisions p
       WHERE p.triage_case_id = w.triage_case_id
       ORDER BY p.record->>'decidedAt' DESC LIMIT 1)),
    'type', w.record->>'type',
    'targetOwningDomain', COALESCE(w.record->'targetOwningDomain',
      CASE WHEN w.record->>'type' = 'create_incident' THEN 'null'::jsonb
      ELSE (SELECT i.record->'primaryOwningDomain' FROM incidents i
            WHERE i.id = w.incident_id) END),
    'idempotencyKey', w.idempotency_key,
    'maxAttempts', COALESCE((w.record->>'maxAttempts')::integer, 3)
  ) WHERE w.record ? 'status';

  CREATE TABLE IF NOT EXISTS timeline_events (
    id uuid PRIMARY KEY,
    incident_id uuid NOT NULL REFERENCES incidents(id),
    record jsonb NOT NULL
  );

  ALTER TABLE evaluations
    DROP CONSTRAINT IF EXISTS evaluations_triage_case_id_key;
  ALTER TABLE policy_decisions
    DROP CONSTRAINT IF EXISTS policy_decisions_triage_case_id_key;
`;

export async function ensureApplicationSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [
      APPLICATION_SCHEMA_LOCK,
    ]);
    await client.query(schemaSql);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [APPLICATION_SCHEMA_LOCK])
      .catch(() => undefined);
    client.release();
  }
}

function clientDatabase(client: PoolClient): TransactionalDatabase {
  return {
    async executeSql(text, values = []) {
      return client.query(text, values);
    },
  };
}

interface MessageSchema<TMessage> {
  parse(input: unknown): TMessage;
}

class PgBossJobQueue<TMessage extends object> {
  readonly #boss: PgBoss;

  constructor(
    connectionString: string,
    readonly name: string,
    private readonly messageSchema: MessageSchema<TMessage>,
  ) {
    this.#boss = new PgBoss({ connectionString });
  }

  async start(): Promise<void> {
    this.#boss.on('error', (error) => {
      console.error('pg-boss error', error);
    });
    await this.#boss.start();
    await this.#boss.createQueue(this.name, { notify: true });
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, timeout: 10_000 });
  }

  async enqueue(
    message: TMessage,
    options: {
      id: string;
      transaction: TransactionalDatabase;
      startAfter?: string;
    },
  ): Promise<void> {
    await this.#boss.send(this.name, this.messageSchema.parse(message), {
      id: options.id,
      db: options.transaction as Db,
      retryLimit: 3,
      retryDelay: 1,
      retryBackoff: true,
      deleteAfterSeconds: 0,
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
    });
  }

  async process(
    handler: (
      message: TMessage,
      transaction: TransactionalDatabase,
    ) => Promise<void>,
  ): Promise<void> {
    await this.#boss.work(
      this.name,
      {
        transactional: true,
        pollingIntervalSeconds: 0.5,
      },
      async (jobs, transaction) => {
        const job = jobs[0];
        if (job) {
          await handler(this.messageSchema.parse(job.data), transaction);
        }
      },
    );
  }
}

function mapHealthJob(row: HealthJobRow): HealthCheckJob {
  return HealthCheckJobSchema.parse({
    id: row.id,
    status: row.status,
    correlationId: row.correlation_id,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    result: row.result,
  });
}

function mapSignal(row: SignalRow): Signal {
  return SignalSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    provider: row.provider,
    sourceEventKey: row.source_event_key,
    sourceReference: row.source_reference,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    service: row.service,
    environment: row.environment,
    region: row.region,
    title: row.title,
    content: row.content,
    facts: row.facts,
    normalizationVersion: row.normalization_version,
    rawFixtureReference: row.raw_fixture_reference,
    correlationId: row.correlation_id,
  });
}

function mapTriageCase(row: TriageCaseRow): TriageCase {
  return TriageCaseSchema.parse({
    id: row.id,
    signalId: row.signal_id,
    status: row.status,
    sourceReference: row.source_reference,
    service: row.service,
    region: row.region,
    receivedAt: row.received_at.toISOString(),
    correlationId: row.correlation_id,
  });
}

interface WorkflowActionStateRow {
  record: WorkflowActionDefinition;
  status: WorkflowAction['status'];
  provider_reference: string | null;
  next_retry_at: Date | null;
  suppressed_count: number;
  failure_reason: string | null;
}

function mapWorkflowAction(
  row: WorkflowActionStateRow,
  attempts: unknown = [],
): WorkflowAction {
  return WorkflowActionSchema.parse({
    ...row.record,
    status: row.status,
    providerReference: row.provider_reference,
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    suppressedCount: row.suppressed_count,
    failureReason: row.failure_reason,
    attempts,
  });
}

async function loadWorkflowActions(
  pool: Pool,
  column: 'triage_case_id' | 'incident_id',
  id: string,
): Promise<WorkflowAction[]> {
  const result = await pool.query<
    WorkflowActionStateRow & { attempts: unknown }
  >(
    `SELECT w.record, l.status, l.provider_reference, l.next_retry_at,
       l.suppressed_count, l.failure_reason,
       COALESCE(jsonb_agg(a.record ORDER BY a.sequence, a.record->>'attemptedAt')
         FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS attempts
     FROM workflow_actions w
     JOIN effects_ledger l ON l.action_id = w.id
     LEFT JOIN action_attempts a ON a.action_id = w.id
     WHERE w.${column} = $1
     GROUP BY w.id, l.idempotency_key
     ORDER BY CASE w.record->>'type'
       WHEN 'create_incident' THEN 1 WHEN 'assign_owner' THEN 2 ELSE 3 END`,
    [id],
  );
  return result.rows.map((row) => mapWorkflowAction(row, row.attempts));
}

export class PostgresHealthSystem implements HealthSystem {
  constructor(
    private readonly pool: Pool,
    private readonly queue: HealthJobQueue,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
  }

  async stop(): Promise<void> {
    await this.queue.stop();
    await this.pool.end();
  }

  async readiness(): Promise<HealthStatus> {
    const checkedAt = this.clock.now();

    try {
      await this.pool.query('SELECT 1');
      const heartbeat = await this.pool.query<{ observed_at: Date }>(
        `SELECT observed_at
         FROM worker_heartbeats
         WHERE worker_name = $1`,
        [this.queue.name],
      );
      const observedAt = heartbeat.rows[0]?.observed_at;
      const workerReady =
        observedAt !== undefined &&
        checkedAt.getTime() - observedAt.getTime() <= WORKER_READY_WINDOW_MS;

      return {
        status: workerReady ? 'ready' : 'degraded',
        api: 'ready',
        database: 'ready',
        worker: workerReady ? 'ready' : 'unavailable',
        checkedAt: checkedAt.toISOString(),
      };
    } catch {
      return {
        status: 'degraded',
        api: 'ready',
        database: 'unavailable',
        worker: 'unavailable',
        checkedAt: checkedAt.toISOString(),
      };
    }
  }

  async submitHealthCheck(correlationId: string): Promise<HealthCheckJob> {
    const id = randomUUID();
    const requestedAt = this.clock.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const inserted = await client.query<HealthJobRow>(
        `INSERT INTO health_check_jobs (
           id, status, correlation_id, requested_at, completed_at, result
         ) VALUES ($1, 'queued', $2, $3, NULL, NULL)
         RETURNING *`,
        [id, correlationId, requestedAt],
      );

      await this.queue.enqueue(
        {
          version: 1,
          healthJobId: id,
          correlationId,
        },
        { id, transaction: clientDatabase(client) },
      );
      await client.query('COMMIT');

      return mapHealthJob(inserted.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findHealthCheck(id: string): Promise<HealthCheckJob | null> {
    const result = await this.pool.query<HealthJobRow>(
      'SELECT * FROM health_check_jobs WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? mapHealthJob(row) : null;
  }
}

export class PgBossHealthJobWorker {
  #heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly pool: Pool,
    private readonly queue: HealthJobQueue,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
    await this.recordHeartbeat();

    this.#heartbeatTimer = setInterval(() => {
      void this.recordHeartbeat();
    }, 5_000);
    this.#heartbeatTimer.unref();

    await this.queue.process(async (message, transaction) => {
      await this.complete(message, transaction);
    });
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
    }
    await this.queue.stop();
    await this.pool.end();
  }

  private async complete(
    message: HealthCheckMessageV1,
    transaction: TransactionalDatabase,
  ): Promise<void> {
    await transaction.executeSql(
      `UPDATE health_check_jobs
       SET status = 'completed', completed_at = $2, result = $3::jsonb
       WHERE id = $1`,
      [
        message.healthJobId,
        this.clock.now(),
        JSON.stringify({
          message: 'Durable health check completed',
          queue: this.queue.name,
        }),
      ],
    );

    console.info(
      JSON.stringify({
        event: 'health_job.completed',
        healthJobId: message.healthJobId,
        correlationId: message.correlationId,
      }),
    );
  }

  private async recordHeartbeat(): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_heartbeats (worker_name, observed_at)
       VALUES ($1, $2)
       ON CONFLICT (worker_name)
       DO UPDATE SET observed_at = EXCLUDED.observed_at`,
      [this.queue.name, this.clock.now()],
    );
  }
}

export class PostgresTriageSystem implements TriageSystem {
  constructor(
    private readonly pool: Pool,
    private readonly queue: TriageJobQueue,
    private readonly actionQueue: PgBossJobQueue<WorkflowActionJobMessageV1>,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
    await this.actionQueue.start();
  }

  async stop(): Promise<void> {
    await this.actionQueue.stop();
    await this.queue.stop();
    await this.pool.end();
  }

  async replayWorkflowAction(actionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ record: WorkflowActionDefinition }>(
        'SELECT record FROM workflow_actions WHERE id = $1',
        [actionId],
      );
      const action = WorkflowActionDefinitionSchema.parse(
        result.rows[0]?.record,
      );
      await this.actionQueue.enqueue(
        { version: 1, actionId, correlationId: action.correlationId },
        { id: randomUUID(), transaction: clientDatabase(client) },
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestMonitoringAlert(
    input: MonitoringAlertInput,
    correlationId: string,
  ): Promise<MonitoringAlertIngestionResult> {
    return MonitoringAlertIngestionResultSchema.parse(
      await this.ingestSignal(
        {
          sourceType: 'monitoring_alert',
          provider: input.provider,
          sourceEventKey: input.sourceEventKey,
          sourceReference: input.sourceReference,
          occurredAt: input.occurredAt,
          service: input.service,
          environment: input.environment ?? null,
          region: input.region,
          title: input.title ?? null,
          content: input.content ?? null,
          facts: {
            metric: input.metric,
            threshold: input.threshold,
            observedValue: input.observedValue,
            evaluationWindowSeconds: input.evaluationWindowSeconds,
          },
          rawFixtureReference: input.rawFixtureReference ?? null,
        },
        correlationId,
      ),
    );
  }

  async ingestDeploymentEvent(
    input: DeploymentEventInput,
    correlationId: string,
  ): Promise<DeploymentEventIngestionResult> {
    return DeploymentEventIngestionResultSchema.parse(
      await this.ingestSignal(
        {
          sourceType: 'deployment_event',
          provider: input.provider,
          sourceEventKey: input.sourceEventKey,
          sourceReference: input.sourceReference,
          occurredAt: input.occurredAt,
          service: input.service,
          environment: input.environment ?? null,
          region: input.region,
          title: input.title ?? null,
          content: input.content ?? null,
          facts: {
            version: input.version,
            commitReference: input.commitReference,
            deployer: input.deployer,
            outcome: input.outcome,
          },
          rawFixtureReference: input.rawFixtureReference ?? null,
        },
        correlationId,
      ),
    );
  }

  async ingestCustomerReport(
    input: CustomerReportInput,
    correlationId: string,
  ): Promise<CustomerReportIngestionResult> {
    return CustomerReportIngestionResultSchema.parse(
      await this.ingestSignal(
        {
          sourceType: 'customer_report',
          provider: input.provider,
          sourceEventKey: input.sourceEventKey,
          sourceReference: input.sourceReference,
          occurredAt: input.reportedAt ?? null,
          service: input.service ?? 'unknown',
          environment: input.environment ?? null,
          region: input.region ?? null,
          title: input.subject,
          content: input.message,
          facts: {
            subject: input.subject,
            message: input.message,
            customerReference: input.customerReference ?? null,
            affectedOperation: input.affectedOperation ?? null,
            reportedAt: input.reportedAt ?? null,
          },
          rawFixtureReference: input.rawFixtureReference ?? null,
        },
        correlationId,
      ),
    );
  }

  private async ingestSignal(
    input: NormalizedSignalDraft,
    correlationId: string,
  ): Promise<{
    signal: Signal;
    triageCase: TriageCase;
    deduplicated: boolean;
  }> {
    const signalId = randomUUID();
    const triageCaseId = randomUUID();
    const receivedAt = this.clock.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const insertedSignal = await client.query<SignalRow>(
        `INSERT INTO signals (
           id, source_type, provider, source_event_key, source_reference,
           occurred_at, received_at, service, environment, region, title,
           content, facts, normalization_version, raw_fixture_reference,
           correlation_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13::jsonb, 1, $14, $15
         )
         ON CONFLICT (provider, source_event_key) DO NOTHING
         RETURNING *`,
        [
          signalId,
          input.sourceType,
          input.provider,
          input.sourceEventKey,
          input.sourceReference,
          input.occurredAt ?? receivedAt.toISOString(),
          receivedAt,
          input.service,
          input.environment ?? null,
          input.region,
          input.title ?? null,
          input.content ?? null,
          JSON.stringify(input.facts),
          input.rawFixtureReference,
          correlationId,
        ],
      );

      const signalRow = insertedSignal.rows[0];
      if (!signalRow) {
        const duplicateSignal = await client.query<SignalRow>(
          `SELECT * FROM signals
           WHERE provider = $1 AND source_event_key = $2`,
          [input.provider, input.sourceEventKey],
        );
        const duplicateCase = await client.query<TriageCaseRow>(
          `SELECT tc.*
           FROM triage_cases tc
           JOIN signals s ON s.id = tc.signal_id
           WHERE s.provider = $1 AND s.source_event_key = $2`,
          [input.provider, input.sourceEventKey],
        );
        await client.query('COMMIT');

        return {
          signal: mapSignal(duplicateSignal.rows[0]!),
          triageCase: mapTriageCase(duplicateCase.rows[0]!),
          deduplicated: true,
        };
      }

      const insertedCase = await client.query<TriageCaseRow>(
        `INSERT INTO triage_cases (
           id, signal_id, status, source_reference, service, region,
           received_at, correlation_id
         ) VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          triageCaseId,
          signalId,
          input.sourceReference,
          input.service,
          input.region,
          receivedAt,
          correlationId,
        ],
      );

      await this.queue.enqueue(
        { version: 1, triageCaseId, signalId, correlationId },
        { id: triageCaseId, transaction: clientDatabase(client) },
      );
      await client.query('COMMIT');

      return {
        signal: mapSignal(signalRow),
        triageCase: mapTriageCase(insertedCase.rows[0]!),
        deduplicated: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listTriageCases(): Promise<TriageCase[]> {
    const result = await this.pool.query<TriageCaseRow>(
      `SELECT * FROM triage_cases
       ORDER BY received_at DESC, id DESC`,
    );
    return result.rows.map(mapTriageCase);
  }

  async listReviewTasks(): Promise<ReviewQueue> {
    const result = await this.pool.query<
      TriageCaseRow & { review_record: unknown }
    >(
      `SELECT tc.*, rt.record AS review_record
       FROM review_tasks rt JOIN triage_cases tc ON tc.id = rt.triage_case_id
       WHERE rt.record->>'resolvedAt' IS NULL
       ORDER BY CASE rt.record->>'urgency' WHEN 'urgent' THEN 0 ELSE 1 END,
         tc.received_at, tc.id`,
    );
    return {
      items: result.rows.map((row) => ({
        reviewTask: ReviewTaskSchema.parse(row.review_record),
        triageCase: mapTriageCase(row),
      })),
    };
  }

  async resolveReview(
    id: string,
    command: ReviewCommand,
  ): Promise<TriageCaseDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const caseResult = await client.query<TriageCaseRow>(
        'SELECT * FROM triage_cases WHERE id = $1 FOR UPDATE',
        [id],
      );
      const triageCase = caseResult.rows[0];
      if (!triageCase) {
        await client.query('ROLLBACK');
        return null;
      }
      const taskResult = await client.query<{ record: unknown }>(
        'SELECT record FROM review_tasks WHERE triage_case_id = $1 FOR UPDATE',
        [id],
      );
      const task = taskResult.rows[0]
        ? ReviewTaskSchema.parse(taskResult.rows[0].record)
        : null;
      if (!task || task.resolvedAt) {
        throw new ReviewConflictError('Review Task is not open');
      }
      const allowed =
        triageCase.status === 'needs_review'
          ? ['create_incident', 'link_incident', 'dismiss']
          : triageCase.status === 'incident_created'
            ? ['assign_owner']
            : triageCase.status === 'evidence_linked'
              ? ['accept_link']
              : [];
      if (!allowed.includes(command.resolution.type)) {
        throw new ReviewConflictError(
          'Resolution is not available for this Triage Case',
        );
      }
      const signalResult = await client.query<SignalRow>(
        'SELECT * FROM signals WHERE id = $1',
        [triageCase.signal_id],
      );
      const signal = mapSignal(signalResult.rows[0]!);
      const timestamp = this.clock.now().toISOString();
      let incidentId: string | null = null;
      if (command.resolution.type === 'create_incident') {
        const incident = IncidentSchema.parse({
          id: randomUUID(),
          title: signal.title ?? signal.sourceReference,
          status: 'open',
          resolvedAt: null,
          currentPriority: command.resolution.priority,
          primaryOwningDomain: command.resolution.owningDomain,
          createdAt: timestamp,
          correlationId: triageCase.correlation_id,
        });
        incidentId = incident.id;
        await client.query(
          'INSERT INTO incidents (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
          [incident.id, id, JSON.stringify(incident)],
        );
        const event = TimelineEventSchema.parse({
          id: randomUUID(),
          correlationId: triageCase.correlation_id,
          type: 'incident_created',
          occurredAt: timestamp,
          summary: `Operator ${command.actor} created this Incident after review.`,
        });
        await client.query(
          'INSERT INTO timeline_events (id, incident_id, record) VALUES ($1, $2, $3::jsonb)',
          [event.id, incident.id, JSON.stringify(event)],
        );
        await client.query(
          "UPDATE triage_cases SET status = 'incident_created' WHERE id = $1",
          [id],
        );
      } else if (command.resolution.type === 'link_incident') {
        const target = await client.query(
          'SELECT id FROM incidents WHERE id = $1 FOR UPDATE',
          [command.resolution.incidentId],
        );
        if (!target.rows[0]) {
          throw new ReviewTargetNotFoundError('Incident not found');
        }
        const evaluationResult = await client.query<{ id: string }>(
          `SELECT id FROM evaluations WHERE triage_case_id = $1
           ORDER BY record->>'evaluatedAt' DESC LIMIT 1`,
          [id],
        );
        if (!evaluationResult.rows[0]) {
          throw new ReviewConflictError('Review requires an Evaluation');
        }
        const policyResult = await client.query<{ id: string }>(
          `SELECT id FROM policy_decisions WHERE triage_case_id = $1
           ORDER BY record->>'decidedAt' DESC LIMIT 1`,
          [id],
        );
        incidentId = command.resolution.incidentId;
        const link = EvidenceLinkSchema.parse({
          id: randomUUID(),
          incidentId,
          signalId: signal.id,
          evaluationId: evaluationResult.rows[0].id,
          policyDecisionId: policyResult.rows[0]?.id ?? null,
          correlationId: triageCase.correlation_id,
          relationship: 'same_incident',
          createdAt: timestamp,
        });
        await client.query(
          `INSERT INTO evidence_links
           (id, incident_id, signal_id, triage_case_id, evaluation_id, policy_decision_id, record)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            link.id,
            incidentId,
            signal.id,
            id,
            link.evaluationId,
            link.policyDecisionId,
            JSON.stringify(link),
          ],
        );
        const event = TimelineEventSchema.parse({
          id: randomUUID(),
          correlationId: triageCase.correlation_id,
          type: 'evidence_linked',
          occurredAt: timestamp,
          summary: `Operator ${command.actor} linked Signal ${signal.sourceReference} after review.`,
        });
        await client.query(
          'INSERT INTO timeline_events (id, incident_id, record) VALUES ($1, $2, $3::jsonb)',
          [event.id, incidentId, JSON.stringify(event)],
        );
        await client.query(
          "UPDATE triage_cases SET status = 'evidence_linked' WHERE id = $1",
          [id],
        );
      } else if (command.resolution.type === 'assign_owner') {
        const result = await client.query<{ id: string; record: unknown }>(
          'SELECT id, record FROM incidents WHERE triage_case_id = $1 FOR UPDATE',
          [id],
        );
        const incidentRow = result.rows[0];
        if (!incidentRow) throw new ReviewConflictError('Incident is missing');
        const incident = IncidentSchema.parse(incidentRow.record);
        if (incident.primaryOwningDomain !== 'unknown') {
          throw new ReviewConflictError('Incident already has an owner');
        }
        incidentId = incident.id;
        await client.query(
          "UPDATE incidents SET record = jsonb_set(record, '{primaryOwningDomain}', to_jsonb($2::text)) WHERE id = $1",
          [incidentId, command.resolution.owningDomain],
        );
        const event = TimelineEventSchema.parse({
          id: randomUUID(),
          correlationId: triageCase.correlation_id,
          type: 'owner_assigned',
          occurredAt: timestamp,
          summary: `Operator ${command.actor} assigned ${command.resolution.owningDomain} after review.`,
        });
        await client.query(
          'INSERT INTO timeline_events (id, incident_id, record) VALUES ($1, $2, $3::jsonb)',
          [event.id, incidentId, JSON.stringify(event)],
        );
      } else if (command.resolution.type === 'accept_link') {
        const result = await client.query<{ incident_id: string }>(
          'SELECT incident_id FROM evidence_links WHERE triage_case_id = $1',
          [id],
        );
        if (!result.rows[0])
          throw new ReviewConflictError('Evidence Link is missing');
        incidentId = result.rows[0].incident_id;
      } else {
        await client.query(
          "UPDATE triage_cases SET status = 'dismissed' WHERE id = $1",
          [id],
        );
      }
      const override = HumanOverrideSchema.parse({
        id: randomUUID(),
        triageCaseId: id,
        correlationId: triageCase.correlation_id,
        actor: command.actor,
        reason: command.reason,
        recordedAt: timestamp,
        replacementOutcome: command.resolution,
      });
      await client.query(
        'INSERT INTO human_overrides (id, triage_case_id, incident_id, record) VALUES ($1, $2, $3, $4::jsonb)',
        [override.id, id, incidentId, JSON.stringify(override)],
      );
      await client.query(
        "UPDATE review_tasks SET record = jsonb_set(record, '{resolvedAt}', to_jsonb($2::text)) WHERE triage_case_id = $1",
        [id, timestamp],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.findTriageCase(id);
  }

  async overridePriority(
    id: string,
    command: PriorityOverrideCommand,
  ): Promise<IncidentDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        triage_case_id: string;
        record: unknown;
      }>(
        'SELECT triage_case_id, record FROM incidents WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const incident = IncidentSchema.parse(result.rows[0].record);
      const override = HumanOverrideSchema.parse({
        id: randomUUID(),
        triageCaseId: result.rows[0].triage_case_id,
        correlationId: incident.correlationId,
        actor: command.actor,
        reason: command.reason,
        recordedAt: this.clock.now().toISOString(),
        replacementOutcome: {
          type: 'set_priority',
          priority: command.priority,
          incidentId: id,
        },
      });
      await client.query(
        "UPDATE incidents SET record = jsonb_set(record, '{currentPriority}', to_jsonb($2::text)) WHERE id = $1",
        [id, command.priority],
      );
      await client.query(
        'INSERT INTO human_overrides (id, triage_case_id, incident_id, record) VALUES ($1, $2, $3, $4::jsonb)',
        [override.id, override.triageCaseId, id, JSON.stringify(override)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.findIncident(id);
  }

  async findTriageCase(id: string): Promise<TriageCaseDetail | null> {
    const triageResult = await this.pool.query<TriageCaseRow>(
      'SELECT * FROM triage_cases WHERE id = $1',
      [id],
    );
    const triageRow = triageResult.rows[0];
    if (!triageRow) return null;

    const [
      signalResult,
      evaluationResult,
      reviewResult,
      overrideResult,
      factResult,
      policyResult,
      actionResult,
      incidentResult,
      evidenceLinkResult,
      timelineResult,
    ] = await Promise.all([
      this.pool.query<SignalRow>('SELECT * FROM signals WHERE id = $1', [
        triageRow.signal_id,
      ]),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM evaluations WHERE triage_case_id = $1
           ORDER BY record->>'evaluatedAt' DESC LIMIT 1`,
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        'SELECT record FROM review_tasks WHERE triage_case_id = $1',
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM human_overrides WHERE triage_case_id = $1
         ORDER BY record->>'recordedAt', id`,
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        "SELECT record FROM corroborating_facts WHERE triage_case_id = $1 ORDER BY record->>'kind'",
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM policy_decisions WHERE triage_case_id = $1
           ORDER BY record->>'decidedAt' DESC LIMIT 1`,
        [id],
      ),
      loadWorkflowActions(this.pool, 'triage_case_id', id),
      this.pool.query<{ id: string }>(
        'SELECT id FROM incidents WHERE triage_case_id = $1',
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        'SELECT record FROM evidence_links WHERE triage_case_id = $1',
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM timeline_events
           WHERE incident_id = COALESCE(
             (SELECT id FROM incidents WHERE triage_case_id = $1),
             (SELECT incident_id FROM evidence_links WHERE triage_case_id = $1))
           ORDER BY CASE record->>'type'
             WHEN 'incident_created' THEN 1 WHEN 'owner_assigned' THEN 2 ELSE 3 END`,
        [id],
      ),
    ]);

    return TriageCaseDetailSchema.parse({
      triageCase: mapTriageCase(triageRow),
      signal: mapSignal(signalResult.rows[0]!),
      evaluation: evaluationResult.rows[0]?.record ?? null,
      reviewTask: reviewResult.rows[0]?.record ?? null,
      humanOverrides: overrideResult.rows.map((row) => row.record),
      corroboratingFacts: factResult.rows.map((row) => row.record),
      policyDecision: policyResult.rows[0]?.record ?? null,
      workflowActions: actionResult,
      timelineEvents: timelineResult.rows.map((row) => row.record),
      incidentId:
        incidentResult.rows[0]?.id ??
        (evidenceLinkResult.rows[0]?.record as EvidenceLink | undefined)
          ?.incidentId ??
        null,
      evidenceLink: evidenceLinkResult.rows[0]?.record ?? null,
    });
  }

  async findIncident(id: string): Promise<IncidentDetail | null> {
    const incidentResult = await this.pool.query<{
      triage_case_id: string;
      record: unknown;
    }>('SELECT triage_case_id, record FROM incidents WHERE id = $1', [id]);
    const incidentRow = incidentResult.rows[0];
    if (!incidentRow) return null;

    const triageResult = await this.pool.query<TriageCaseRow>(
      'SELECT * FROM triage_cases WHERE id = $1',
      [incidentRow.triage_case_id],
    );
    const triageRow = triageResult.rows[0]!;
    const [
      signalResult,
      evaluationResult,
      reviewResult,
      overrideResult,
      factResult,
      policyResult,
      actionResult,
      timelineResult,
      evidenceResult,
    ] = await Promise.all([
      this.pool.query<SignalRow>('SELECT * FROM signals WHERE id = $1', [
        triageRow.signal_id,
      ]),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM evaluations WHERE triage_case_id = $1
           ORDER BY record->>'evaluatedAt' DESC LIMIT 1`,
        [incidentRow.triage_case_id],
      ),
      this.pool.query<{ record: unknown }>(
        'SELECT record FROM review_tasks WHERE triage_case_id = $1',
        [incidentRow.triage_case_id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM human_overrides WHERE incident_id = $1
         ORDER BY record->>'recordedAt', id`,
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        "SELECT record FROM corroborating_facts WHERE triage_case_id = $1 ORDER BY record->>'kind'",
        [incidentRow.triage_case_id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM policy_decisions WHERE triage_case_id = $1
           ORDER BY record->>'decidedAt' DESC LIMIT 1`,
        [incidentRow.triage_case_id],
      ),
      loadWorkflowActions(this.pool, 'incident_id', id),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM timeline_events WHERE incident_id = $1
           ORDER BY CASE record->>'type'
             WHEN 'incident_created' THEN 1 WHEN 'owner_assigned' THEN 2 ELSE 3 END`,
        [id],
      ),
      this.pool.query<SignalRow & { link: unknown; evaluation: unknown }>(
        `SELECT l.record AS link, e.record AS evaluation, s.*
         FROM evidence_links l
         JOIN signals s ON s.id = l.signal_id
         JOIN evaluations e ON e.id = l.evaluation_id
         WHERE l.incident_id = $1
         ORDER BY l.record->>'createdAt', l.id`,
        [id],
      ),
    ]);

    return IncidentDetailSchema.parse({
      incident: incidentRow.record,
      signal: mapSignal(signalResult.rows[0]!),
      evaluation: evaluationResult.rows[0]!.record,
      reviewTask: reviewResult.rows[0]?.record ?? null,
      humanOverrides: overrideResult.rows.map((row) => row.record),
      corroboratingFacts: factResult.rows.map((row) => row.record),
      policyDecision: policyResult.rows[0]?.record ?? null,
      workflowActions: actionResult,
      timelineEvents: timelineResult.rows.map((row) => row.record),
      evidenceLinks: evidenceResult.rows.map((row) => ({
        link: row.link,
        signal: mapSignal(row),
        evaluation: row.evaluation,
      })),
    });
  }
}

class SimulatedPagingProvider implements PagingProviderPort<PageRequest> {
  readonly #providerReferences = new Map<string, string>();

  async page(page: PageRequest): Promise<{ providerReference: string }> {
    const providerReference =
      this.#providerReferences.get(page.idempotencyKey) ??
      `simulated:${page.idempotencyKey}`;
    this.#providerReferences.set(page.idempotencyKey, providerReference);
    return { providerReference };
  }
}

class SimulatedAssignmentProvider implements AssignmentProviderPort<AssignmentRequest> {
  async assign(
    assignment: AssignmentRequest,
  ): Promise<{ providerReference: string }> {
    return { providerReference: `simulated:${assignment.idempotencyKey}` };
  }
}

export class DeterministicOperationalJudgmentProvider implements OperationalJudgmentProviderPort<
  EvaluationInput,
  OperationalJudgments
> {
  async evaluate(
    input: EvaluationInput,
  ): Promise<OperationalJudgmentResult<OperationalJudgments>> {
    const signal = input.signal;
    return {
      judgments:
        signal.sourceType === 'customer_report'
          ? evaluateCustomerReportDeterministically({
              provider: signal.provider,
              sourceEventKey: signal.sourceEventKey,
              sourceReference: signal.sourceReference,
              subject: signal.facts.subject,
              message: signal.facts.message,
              ...(signal.facts.customerReference
                ? { customerReference: signal.facts.customerReference }
                : {}),
              ...(signal.facts.affectedOperation
                ? { affectedOperation: signal.facts.affectedOperation }
                : {}),
              ...(signal.facts.reportedAt
                ? { reportedAt: signal.facts.reportedAt }
                : {}),
              ...(signal.service !== 'unknown'
                ? { service: signal.service }
                : {}),
              ...(signal.region
                ? { region: signal.region as CustomerReportInput['region'] }
                : {}),
            })
          : signal.sourceType === 'monitoring_alert'
            ? evaluateMonitoringAlertDeterministically({
                provider: signal.provider,
                sourceEventKey: signal.sourceEventKey,
                sourceReference: signal.sourceReference,
                service: signal.service,
                region: signal.region as MonitoringAlertInput['region'],
                occurredAt: signal.occurredAt,
                ...signal.facts,
                ...(signal.environment
                  ? { environment: signal.environment }
                  : {}),
                ...(signal.title ? { title: signal.title } : {}),
                ...(signal.content ? { content: signal.content } : {}),
              })
            : evaluateDeploymentEventDeterministically({
                provider: signal.provider,
                sourceEventKey: signal.sourceEventKey,
                sourceReference: signal.sourceReference,
                service: signal.service,
                region: signal.region as DeploymentEventInput['region'],
                occurredAt: signal.occurredAt,
                ...signal.facts,
              }),
      incidentMatches: input.candidates.map((candidate) => ({
        candidateIncidentId: candidate.id,
        judgment: {
          choice: 'unrelated' as const,
          probabilities: [
            { outcome: 'same_incident' as const, probability: 0.01 },
            { outcome: 'related_distinct' as const, probability: 0.01 },
            { outcome: 'unrelated' as const, probability: 0.98 },
          ],
        },
      })),
      mode: 'deterministic',
      configuredModel: 'deterministic-canonical-v1',
      resolvedModel: 'deterministic-canonical-v1',
      providerRequestId: `deterministic:${signal.sourceEventKey}`,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      retryCount: 0,
    };
  }
}

export class PgBossTriageWorker {
  constructor(
    private readonly pool: Pool,
    private readonly queue: TriageJobQueue,
    private readonly actionQueue: PgBossJobQueue<WorkflowActionJobMessageV1>,
    private readonly clock: Clock,
    private readonly pagingProvider: PagingProviderPort<PageRequest>,
    private readonly assignmentProvider: AssignmentProviderPort<AssignmentRequest>,
    private readonly judgmentProvider: OperationalJudgmentProviderPort<
      EvaluationInput,
      OperationalJudgments
    >,
    private readonly claimLeaseMs: number,
    private readonly afterProviderEffect: (
      action: WorkflowAction,
    ) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
    await this.actionQueue.start();
    await this.queue.process(async (message, transaction) => {
      await this.process(message, transaction);
    });
    await this.actionQueue.process(async (message) => {
      await this.executeAction(message);
    });
  }

  private async process(
    message: TriageJobMessageV1,
    transaction: TransactionalDatabase,
  ): Promise<void> {
    const signalResult = await transaction.executeSql(
      'SELECT * FROM signals WHERE id = $1',
      [message.signalId],
    );
    const signalRow = signalResult.rows[0] as SignalRow | undefined;
    if (!signalRow) throw new Error('Signal for Triage Case was not found');
    const signal = mapSignal(signalRow);

    await transaction.executeSql('SELECT pg_advisory_xact_lock($1)', [
      TRIAGE_MATCH_LOCK,
    ]);

    const completedResult = await transaction.executeSql(
      `SELECT 1 FROM policy_decisions WHERE triage_case_id = $1
       UNION ALL SELECT 1 FROM review_tasks WHERE triage_case_id = $1 LIMIT 1`,
      [message.triageCaseId],
    );
    if (completedResult.rows.length > 0) return;

    const occurredAt = new Date(signal.occurredAt);
    const corroboratingFacts: CorroboratingFact[] = [];
    if (signal.sourceType === 'monitoring_alert') {
      const recentDeploymentResult = await transaction.executeSql(
        `SELECT id FROM signals
         WHERE source_type = 'deployment_event'
           AND service = $1 AND region = $2
           AND facts->>'outcome' = 'succeeded'
           AND occurred_at <= $3
           AND occurred_at >= $3::timestamptz - interval '15 minutes'
         ORDER BY occurred_at DESC LIMIT 1`,
        [signal.service, signal.region, occurredAt],
      );
      if (signal.facts.observedValue > signal.facts.threshold) {
        corroboratingFacts.push(
          CorroboratingFactSchema.parse({
            id: randomUUID(),
            kind: 'threshold_breach',
            summary: `${signal.facts.metric} measured ${signal.facts.observedValue} against threshold ${signal.facts.threshold}.`,
            evidenceSignalIds: [signal.id],
          }),
        );
        const recentDeployment = recentDeploymentResult.rows[0] as
          { id: string } | undefined;
        if (recentDeployment) {
          corroboratingFacts.push(
            CorroboratingFactSchema.parse({
              id: randomUUID(),
              kind: 'recent_deployment',
              summary:
                'A successful deployment for the same service and region completed within 15 minutes.',
              evidenceSignalIds: [recentDeployment.id],
            }),
          );
        }
      }
    }

    const customerReference =
      signal.sourceType === 'customer_report'
        ? signal.facts.customerReference
        : null;
    const affectedOperation =
      signal.sourceType === 'customer_report'
        ? signal.facts.affectedOperation
        : null;
    const searchText = [
      signal.title,
      signal.content,
      signal.sourceReference,
      customerReference,
      affectedOperation,
    ]
      .filter(Boolean)
      .join(' ');
    const knownDomain = Object.hasOwn(NORTHSTAR_SERVICE_DOMAINS, signal.service)
      ? NORTHSTAR_SERVICE_DOMAINS[
          signal.service as keyof typeof NORTHSTAR_SERVICE_DOMAINS
        ]
      : null;
    const candidateResult = await transaction.executeSql(
      `SELECT i.record, s.service, s.region FROM incidents i
       JOIN triage_cases t ON t.id = i.triage_case_id
       JOIN signals s ON s.id = t.signal_id
       WHERE i.record->>'status' <> 'resolved'
          OR (i.record->>'resolvedAt')::timestamptz >= $3::timestamptz - interval '24 hours'
       ORDER BY
         (CASE WHEN position(i.id::text in $4) > 0 THEN 100 ELSE 0 END
          + CASE WHEN position(s.source_reference in $4) > 0 THEN 60 ELSE 0 END
          + CASE WHEN $6::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM evidence_links el
              JOIN signals linked ON linked.id = el.signal_id
              WHERE el.incident_id = i.id
                AND linked.facts->>'customerReference' = $6
            ) THEN 60 ELSE 0 END
          + CASE WHEN s.service = $1 THEN 20 ELSE 0 END
          + CASE WHEN s.region = $2 THEN 10 ELSE 0 END
          + CASE WHEN i.record->>'primaryOwningDomain' = $5 THEN 8 ELSE 0 END
          + CASE WHEN s.facts->>'affectedOperation' = $7 THEN 8 ELSE 0 END
          + 10 * ts_rank(to_tsvector('english',
                         coalesce(i.record->>'title', '') || ' ' ||
                         coalesce(s.title, '') || ' ' ||
                         coalesce(s.content, '') || ' ' || s.source_reference),
                         websearch_to_tsquery('english', $4))
          + 5 * similarity(coalesce(i.record->>'title', ''), $4)) DESC,
         (i.record->>'createdAt') DESC
       LIMIT 5`,
      [
        signal.service,
        signal.region,
        occurredAt,
        searchText,
        knownDomain,
        customerReference,
        affectedOperation,
      ],
    );
    const candidates = candidateResult.rows.map((row) => {
      const candidate = row as {
        record: Incident;
        service: string;
        region: string | null;
      };
      return {
        id: candidate.record.id,
        title: candidate.record.title,
        status: candidate.record.status,
        resolvedAt: candidate.record.resolvedAt,
        currentPriority: candidate.record.currentPriority,
        primaryOwningDomain: candidate.record.primaryOwningDomain,
        service: candidate.service,
        region: candidate.region,
      };
    });
    let judgmentResult: OperationalJudgmentResult<OperationalJudgments>;
    try {
      judgmentResult = await this.judgmentProvider.evaluate({
        signal,
        corroboratingFacts: corroboratingFacts.map(
          ({ kind, summary, evidenceSignalIds }) => ({
            kind,
            summary,
            evidenceSignalIds,
          }),
        ),
        candidates,
      });
    } catch (error) {
      if (!(error instanceof JevEvaluationFailure)) throw error;
      const evaluatedAt = this.clock.now().toISOString();
      const evaluation = EvaluationSchema.parse({
        id: randomUUID(),
        triageCaseId: message.triageCaseId,
        previousEvaluationId: null,
        correlationId: message.correlationId,
        status: 'failed',
        ...error.metadata,
        normalizationVersion: 1,
        decisionSchemaVersion: 'operational-judgments.v1',
        questionSetVersion: JEV_QUESTION_SET_VERSION,
        policyVersion: 'northstar-automation.v1',
        attemptId: randomUUID(),
        evaluatedAt,
        judgments: null,
        incidentMatches: [],
        failure: { kind: error.kind, message: error.message },
      });
      const reviewTask = ReviewTaskSchema.parse({
        id: randomUUID(),
        triageCaseId: message.triageCaseId,
        correlationId: message.correlationId,
        urgency: 'urgent',
        reason: `Evaluation failed: ${error.message}`,
        createdAt: evaluatedAt,
      });
      await transaction.executeSql(
        'INSERT INTO evaluations (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
        [evaluation.id, message.triageCaseId, JSON.stringify(evaluation)],
      );
      await transaction.executeSql(
        'INSERT INTO review_tasks (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (triage_case_id) DO NOTHING',
        [reviewTask.id, message.triageCaseId, JSON.stringify(reviewTask)],
      );
      await transaction.executeSql(
        "UPDATE triage_cases SET status = 'needs_review' WHERE id = $1",
        [message.triageCaseId],
      );
      return;
    }
    const { judgments } = judgmentResult;

    const evaluatedAt = this.clock.now().toISOString();
    const evaluation = EvaluationSchema.parse({
      id: randomUUID(),
      triageCaseId: message.triageCaseId,
      previousEvaluationId: null,
      correlationId: message.correlationId,
      status: 'succeeded',
      mode: judgmentResult.mode,
      configuredModel: judgmentResult.configuredModel,
      resolvedModel: judgmentResult.resolvedModel,
      normalizationVersion: 1,
      decisionSchemaVersion: 'operational-judgments.v1',
      questionSetVersion: JEV_QUESTION_SET_VERSION,
      policyVersion: 'northstar-automation.v1',
      attemptId: randomUUID(),
      providerRequestId: judgmentResult.providerRequestId,
      inputTokens: judgmentResult.inputTokens,
      outputTokens: judgmentResult.outputTokens,
      latencyMs: judgmentResult.latencyMs,
      retryCount: judgmentResult.retryCount,
      evaluatedAt,
      judgments,
      incidentMatches: judgmentResult.incidentMatches,
      failure: null,
    });
    const relationship = decideIncidentRelationship(
      candidates.map((candidate) => candidate.id),
      evaluation.incidentMatches,
    );
    const automation = decideAutomation(
      judgments,
      corroboratingFacts.length > 0,
      relationship,
    );
    const policyDecision = PolicyDecisionSchema.parse({
      id: randomUUID(),
      triageCaseId: message.triageCaseId,
      evaluationId: evaluation.id,
      supersedesPolicyDecisionId: null,
      correlationId: message.correlationId,
      version: 'northstar-automation.v1',
      thresholds: automation.thresholds,
      rules: automation.rules,
      authorizedActions: automation.authorizedActions,
      decidedAt: evaluatedAt,
    });

    await transaction.executeSql(
      'INSERT INTO evaluations (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
      [evaluation.id, message.triageCaseId, JSON.stringify(evaluation)],
    );
    for (const fact of corroboratingFacts) {
      await transaction.executeSql(
        'INSERT INTO corroborating_facts (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
        [fact.id, message.triageCaseId, JSON.stringify(fact)],
      );
    }
    await transaction.executeSql(
      'INSERT INTO policy_decisions (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
      [policyDecision.id, message.triageCaseId, JSON.stringify(policyDecision)],
    );

    if (automation.authorizedActions.includes('create_evidence_link')) {
      const incidentId = relationship.incidentId!;
      const incidentResult = await transaction.executeSql(
        'SELECT record FROM incidents WHERE id = $1 FOR UPDATE',
        [incidentId],
      );
      const incident = IncidentSchema.parse(
        (incidentResult.rows[0] as { record: unknown }).record,
      );
      const link = EvidenceLinkSchema.parse({
        id: randomUUID(),
        incidentId,
        signalId: signal.id,
        evaluationId: evaluation.id,
        policyDecisionId: policyDecision.id,
        correlationId: message.correlationId,
        relationship: 'same_incident',
        createdAt: evaluatedAt,
      });
      await transaction.executeSql(
        `INSERT INTO evidence_links
         (id, incident_id, signal_id, triage_case_id, evaluation_id, policy_decision_id, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          link.id,
          incidentId,
          signal.id,
          message.triageCaseId,
          evaluation.id,
          policyDecision.id,
          JSON.stringify(link),
        ],
      );
      await this.createAction(
        transaction,
        message.triageCaseId,
        incident,
        policyDecision,
        'create_evidence_link',
        'succeeded',
        null,
        evaluatedAt,
      );
      if (incident.status === 'resolved') {
        const reviewTask = ReviewTaskSchema.parse({
          id: randomUUID(),
          triageCaseId: message.triageCaseId,
          correlationId: message.correlationId,
          urgency: 'standard',
          reason:
            'Evidence linked to a resolved Incident; Operator review is required.',
          createdAt: evaluatedAt,
        });
        await transaction.executeSql(
          'INSERT INTO review_tasks (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (triage_case_id) DO NOTHING',
          [reviewTask.id, message.triageCaseId, JSON.stringify(reviewTask)],
        );
      }
      await transaction.executeSql(
        "UPDATE triage_cases SET status = 'evidence_linked' WHERE id = $1 AND signal_id = $2",
        [message.triageCaseId, signal.id],
      );
      return;
    }

    if (!automation.authorizedActions.includes('create_incident')) {
      const reviewTask = ReviewTaskSchema.parse({
        id: randomUUID(),
        triageCaseId: message.triageCaseId,
        correlationId: message.correlationId,
        urgency: reviewUrgency(
          judgments.priorityAssessment,
          corroboratingFacts.length > 0,
        ),
        reason:
          judgments.evidenceSufficiency.yesProbability <
          automation.thresholds.evidenceSufficiencyYesProbability
            ? 'Evidence Sufficiency is below the automation threshold; Operator review is required.'
            : relationship.outcome === 'review'
              ? 'Candidate relationship is uncertain or related but distinct; Operator review is required.'
              : relationship.outcome === 'same_incident'
                ? 'Incident Match or Evidence Sufficiency did not authorize an Evidence Link.'
                : 'Operational Judgments did not meet Incident creation policy.',
        createdAt: evaluatedAt,
      });
      await transaction.executeSql(
        'INSERT INTO review_tasks (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (triage_case_id) DO NOTHING',
        [reviewTask.id, message.triageCaseId, JSON.stringify(reviewTask)],
      );
      await transaction.executeSql(
        `UPDATE triage_cases SET status = 'needs_review'
         WHERE id = $1 AND signal_id = $2`,
        [message.triageCaseId, message.signalId],
      );
      return;
    }

    const incident = IncidentSchema.parse({
      id: randomUUID(),
      title: signal.title ?? 'Checkout payment authorization failures',
      status: 'open',
      currentPriority: judgments.priorityAssessment.choice,
      primaryOwningDomain: 'unknown',
      createdAt: evaluatedAt,
      correlationId: message.correlationId,
    });
    await transaction.executeSql(
      'INSERT INTO incidents (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
      [incident.id, message.triageCaseId, JSON.stringify(incident)],
    );

    await this.createAction(
      transaction,
      message.triageCaseId,
      incident,
      policyDecision,
      'create_incident',
      'succeeded',
      null,
      evaluatedAt,
    );
    if (automation.authorizedActions.includes('assign_owner')) {
      const assignment = await this.createAction(
        transaction,
        message.triageCaseId,
        incident,
        policyDecision,
        'assign_owner',
        'pending',
        judgments.primaryOwningDomain
          .choice as AssignmentRequest['owningDomain'],
        evaluatedAt,
      );
      await this.enqueueAction(transaction, assignment);
    }
    if (automation.authorizedActions.includes('page_on_call')) {
      await this.createAction(
        transaction,
        message.triageCaseId,
        incident,
        policyDecision,
        'page_on_call',
        'pending',
        judgments.primaryOwningDomain.choice as PageRequest['owningDomain'],
        evaluatedAt,
      );
    }

    if (judgments.primaryOwningDomain.choice === 'unknown') {
      const reviewTask = ReviewTaskSchema.parse({
        id: randomUUID(),
        triageCaseId: message.triageCaseId,
        correlationId: message.correlationId,
        urgency: reviewUrgency(
          judgments.priorityAssessment,
          corroboratingFacts.length > 0,
        ),
        reason:
          'Primary Owning Domain is unknown; assignment requires Operator review.',
        createdAt: evaluatedAt,
      });
      await transaction.executeSql(
        'INSERT INTO review_tasks (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT (triage_case_id) DO NOTHING',
        [reviewTask.id, message.triageCaseId, JSON.stringify(reviewTask)],
      );
    }

    await transaction.executeSql(
      `UPDATE triage_cases SET status = 'incident_created'
       WHERE id = $1 AND signal_id = $2`,
      [message.triageCaseId, message.signalId],
    );
  }

  private async createAction(
    transaction: TransactionalDatabase,
    triageCaseId: string,
    incident: Incident,
    policyDecision: PolicyDecision,
    type: WorkflowAction['type'],
    status: WorkflowAction['status'],
    targetOwningDomain: WorkflowAction['targetOwningDomain'],
    occurredAt: string,
  ): Promise<WorkflowAction> {
    const idempotencyKey = `workflow:${policyDecision.version}:${policyDecision.id}:${type}`;
    const action = WorkflowActionSchema.parse({
      id: workflowActionId(idempotencyKey),
      correlationId: policyDecision.correlationId,
      policyDecisionId: policyDecision.id,
      type,
      targetOwningDomain,
      status,
      idempotencyKey,
      providerReference: null,
      nextRetryAt: null,
      maxAttempts: 3,
      suppressedCount: 0,
      failureReason: null,
      attempts: [],
    });
    await transaction.executeSql(
      `INSERT INTO workflow_actions (
         id, triage_case_id, incident_id, idempotency_key, record
       ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        action.id,
        triageCaseId,
        incident.id,
        idempotencyKey,
        JSON.stringify(WorkflowActionDefinitionSchema.parse(action)),
      ],
    );
    await transaction.executeSql(
      `INSERT INTO effects_ledger
         (idempotency_key, action_id, status)
       VALUES ($1, $2, $3)`,
      [action.idempotencyKey, action.id, status],
    );
    if (status === 'succeeded') {
      await this.appendAttempt(
        transaction,
        action.id,
        1,
        'started',
        occurredAt,
      );
      await this.appendAttempt(
        transaction,
        action.id,
        2,
        'succeeded',
        occurredAt,
      );
      await this.appendTimeline(
        transaction,
        incident.id,
        policyDecision.correlationId,
        type === 'create_evidence_link'
          ? 'evidence_linked'
          : 'incident_created',
        type === 'create_evidence_link'
          ? 'Customer Report linked as supporting evidence by the authorized Policy Decision.'
          : 'Incident created open from the authorized Policy Decision.',
        occurredAt,
      );
    }
    return action;
  }

  private async appendAttempt(
    transaction: TransactionalDatabase,
    actionId: string,
    sequence: number,
    outcome:
      | 'started'
      | 'succeeded'
      | 'transient_failure'
      | 'permanent_failure'
      | 'interrupted'
      | 'suppressed',
    attemptedAt: string,
    providerReference: string | null = null,
    detail: string | null = null,
  ): Promise<void> {
    const attempt = ActionAttemptSchema.parse({
      id: randomUUID(),
      sequence,
      attemptedAt,
      outcome,
      providerReference,
      detail,
    });
    await transaction.executeSql(
      `INSERT INTO action_attempts (id, action_id, sequence, record)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [attempt.id, actionId, sequence, JSON.stringify(attempt)],
    );
  }

  private async appendTimeline(
    transaction: TransactionalDatabase,
    incidentId: string,
    correlationId: string,
    type: TimelineEvent['type'],
    summary: string,
    occurredAt: string,
  ): Promise<void> {
    const event = TimelineEventSchema.parse({
      id: randomUUID(),
      correlationId,
      type,
      occurredAt,
      summary,
    });
    await transaction.executeSql(
      'INSERT INTO timeline_events (id, incident_id, record) VALUES ($1, $2, $3::jsonb)',
      [event.id, incidentId, JSON.stringify(event)],
    );
  }

  private async enqueueAction(
    transaction: TransactionalDatabase,
    action: WorkflowAction,
    startAfter?: string,
  ): Promise<void> {
    await this.actionQueue.enqueue(
      { version: 1, actionId: action.id, correlationId: action.correlationId },
      { id: randomUUID(), transaction, ...(startAfter ? { startAfter } : {}) },
    );
  }

  private async saveActionState(
    transaction: TransactionalDatabase,
    action: WorkflowAction,
  ): Promise<void> {
    await transaction.executeSql(
      `UPDATE effects_ledger SET status = $2, provider_reference = $3,
         next_retry_at = $4, suppressed_count = $5, failure_reason = $6
       WHERE action_id = $1`,
      [
        action.id,
        action.status,
        action.providerReference,
        action.nextRetryAt,
        action.suppressedCount,
        action.failureReason,
      ],
    );
  }

  private async urgentFailureReview(
    transaction: TransactionalDatabase,
    triageCaseId: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const review = ReviewTaskSchema.parse({
      id: randomUUID(),
      triageCaseId,
      correlationId,
      urgency: 'urgent',
      reason,
      createdAt: this.clock.now().toISOString(),
    });
    await transaction.executeSql(
      `INSERT INTO review_tasks (id, triage_case_id, record)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (triage_case_id) DO UPDATE SET record =
         jsonb_set(
           jsonb_set(review_tasks.record, '{urgency}', '"urgent"'::jsonb),
           '{reason}', to_jsonb($4::text)
         )`,
      [review.id, triageCaseId, JSON.stringify(review), reason],
    );
    await transaction.executeSql(
      "UPDATE triage_cases SET status = 'needs_review' WHERE id = $1",
      [triageCaseId],
    );
  }

  private async executeAction(
    message: WorkflowActionJobMessageV1,
  ): Promise<void> {
    const client = await this.pool.connect();
    let claimed: {
      action: WorkflowAction;
      incidentId: string;
      triageCaseId: string;
      token: string;
    } | null = null;
    try {
      await client.query('BEGIN');
      const result = await client.query<
        WorkflowActionStateRow & {
          incident_id: string;
          triage_case_id: string;
          claimed_at: Date | null;
        }
      >(
        `SELECT w.incident_id, w.triage_case_id, w.record,
                l.status, l.provider_reference, l.next_retry_at,
                l.suppressed_count, l.failure_reason, l.claimed_at
         FROM workflow_actions w
         JOIN effects_ledger l ON l.action_id = w.id
         WHERE w.id = $1 FOR UPDATE OF w, l`,
        [message.actionId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Workflow Action was not found');
      const action = mapWorkflowAction(row);
      if (action.correlationId !== message.correlationId)
        throw new Error('Workflow Action correlation mismatch');
      const countResult = await client.query<{
        sequence: number;
        starts: number;
      }>(
        `SELECT COALESCE(MAX(sequence), 0)::int AS sequence,
                COUNT(*) FILTER (WHERE record->>'outcome' = 'started')::int AS starts
         FROM action_attempts WHERE action_id = $1`,
        [action.id],
      );
      let sequence = countResult.rows[0]!.sequence;
      const startedCount = countResult.rows[0]!.starts;
      const now = this.clock.now().toISOString();
      const transaction = clientDatabase(client);
      if (
        action.status === 'succeeded' ||
        action.status === 'permanently_failed' ||
        (action.status === 'executing' &&
          row.claimed_at &&
          Date.now() - row.claimed_at.getTime() < this.claimLeaseMs) ||
        (action.status === 'retry_scheduled' &&
          action.nextRetryAt &&
          Date.now() < new Date(action.nextRetryAt).getTime())
      ) {
        action.suppressedCount++;
        await this.appendAttempt(
          transaction,
          action.id,
          ++sequence,
          'suppressed',
          now,
          null,
          `Duplicate delivery while action was ${action.status}.`,
        );
        await this.saveActionState(transaction, action);
        if (action.status === 'executing')
          await this.enqueueAction(
            transaction,
            action,
            `${Math.ceil(this.claimLeaseMs / 1000)} seconds`,
          );
        await client.query('COMMIT');
        return;
      }
      if (action.status === 'executing')
        await this.appendAttempt(
          transaction,
          action.id,
          ++sequence,
          'interrupted',
          now,
          null,
          'Previous worker stopped before recording the provider result.',
        );
      if (startedCount >= action.maxAttempts) {
        action.status = 'permanently_failed';
        action.failureReason =
          'Execution attempts exhausted after worker interruption.';
        await this.saveActionState(transaction, action);
        await client.query(
          `UPDATE effects_ledger SET status = 'permanently_failed',
          claim_token = NULL WHERE action_id = $1`,
          [action.id],
        );
        await this.urgentFailureReview(
          transaction,
          row.triage_case_id,
          action.correlationId,
          `${action.type} permanently failed: ${action.failureReason}`,
        );
        await client.query('COMMIT');
        return;
      }
      const token = randomUUID();
      action.status = 'executing';
      action.nextRetryAt = null;
      await this.appendAttempt(
        transaction,
        action.id,
        ++sequence,
        'started',
        now,
      );
      await this.saveActionState(transaction, action);
      await client.query(
        `UPDATE effects_ledger SET status = 'executing',
        claimed_at = now(), claim_token = $2 WHERE action_id = $1`,
        [action.id, token],
      );
      await client.query('COMMIT');
      claimed = {
        action,
        incidentId: row.incident_id,
        triageCaseId: row.triage_case_id,
        token,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!claimed) return;
    const { action, incidentId } = claimed;
    const incidentResult = await this.pool.query<{ record: Incident }>(
      'SELECT record FROM incidents WHERE id = $1',
      [incidentId],
    );
    const incident = IncidentSchema.parse(incidentResult.rows[0]!.record);
    let providerReference: string | null = null;
    let failure: unknown = null;
    try {
      if (action.type === 'assign_owner') {
        const result = await this.assignmentProvider.assign(
          AssignmentRequestSchema.parse({
            incidentId,
            correlationId: action.correlationId,
            owningDomain: action.targetOwningDomain,
            idempotencyKey: action.idempotencyKey,
          }),
        );
        providerReference = result.providerReference;
      } else if (action.type === 'page_on_call') {
        const result = await this.pagingProvider.page(
          PageRequestSchema.parse({
            incidentId,
            correlationId: action.correlationId,
            priority: incident.currentPriority,
            owningDomain: action.targetOwningDomain,
            summary: incident.title,
            idempotencyKey: action.idempotencyKey,
          }),
        );
        providerReference = result.providerReference;
      } else {
        throw new Error(
          'Incident creation is committed with its Policy Decision',
        );
      }
    } catch (error) {
      failure = error;
      if (error instanceof WorkflowProviderError)
        providerReference = error.providerReference;
    }
    if (!failure) await this.afterProviderEffect(action);
    await this.finishAction(claimed, providerReference, failure);
  }

  private async finishAction(
    claim: {
      action: WorkflowAction;
      incidentId: string;
      triageCaseId: string;
      token: string;
    },
    providerReference: string | null,
    failure: unknown,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<
        WorkflowActionStateRow & {
          claim_token: string;
        }
      >(
        `SELECT w.record, l.status, l.provider_reference, l.next_retry_at,
                l.suppressed_count, l.failure_reason, l.claim_token
         FROM workflow_actions w
         JOIN effects_ledger l ON l.action_id = w.id
         WHERE w.id = $1 FOR UPDATE OF w, l`,
        [claim.action.id],
      );
      const row = result.rows[0]!;
      if (row.claim_token !== claim.token) {
        await client.query('COMMIT');
        return;
      }
      const action = mapWorkflowAction(row);
      const sequenceResult = await client.query<{
        next_sequence: number;
        starts: number;
      }>(
        `SELECT (COALESCE(MAX(sequence), 0) + 1)::int AS next_sequence,
                COUNT(*) FILTER (WHERE record->>'outcome' = 'started')::int AS starts
         FROM action_attempts WHERE action_id = $1`,
        [action.id],
      );
      const { next_sequence: sequence, starts } = sequenceResult.rows[0]!;
      const now = this.clock.now().toISOString();
      const transaction = clientDatabase(client);
      if (!failure) {
        action.status = 'succeeded';
        action.providerReference = providerReference;
        action.failureReason = null;
        await this.appendAttempt(
          transaction,
          action.id,
          sequence,
          'succeeded',
          now,
          providerReference,
        );
        if (action.type === 'assign_owner') {
          await client.query(
            `UPDATE incidents SET record = jsonb_set(record,
            '{primaryOwningDomain}', to_jsonb($2::text)) WHERE id = $1`,
            [claim.incidentId, action.targetOwningDomain],
          );
          await this.appendTimeline(
            transaction,
            claim.incidentId,
            action.correlationId,
            'owner_assigned',
            `${action.targetOwningDomain} assigned as Primary Owning Domain.`,
            now,
          );
          const pageResult = await client.query<WorkflowActionStateRow>(
            `SELECT w.record, l.status, l.provider_reference, l.next_retry_at,
                    l.suppressed_count, l.failure_reason
             FROM workflow_actions w JOIN effects_ledger l ON l.action_id = w.id
             WHERE w.triage_case_id = $1 AND w.record->>'type' = 'page_on_call'`,
            [claim.triageCaseId],
          );
          if (pageResult.rows[0])
            await this.enqueueAction(
              transaction,
              mapWorkflowAction(pageResult.rows[0]),
            );
        } else {
          await this.appendTimeline(
            transaction,
            claim.incidentId,
            action.correlationId,
            'on_call_paged',
            `${action.targetOwningDomain} On-call Engineer paged.`,
            now,
          );
        }
      } else {
        const detail =
          failure instanceof Error ? failure.message : String(failure);
        const retryable =
          !(failure instanceof WorkflowProviderError) || failure.retryable;
        const terminal = !retryable || starts >= action.maxAttempts;
        action.failureReason = detail;
        action.providerReference =
          providerReference ?? action.providerReference;
        if (terminal) {
          action.status = 'permanently_failed';
          action.nextRetryAt = null;
          await this.appendAttempt(
            transaction,
            action.id,
            sequence,
            'permanent_failure',
            now,
            providerReference,
            detail,
          );
          await this.urgentFailureReview(
            transaction,
            claim.triageCaseId,
            action.correlationId,
            `${action.type} permanently failed: ${detail}`,
          );
          if (action.type === 'assign_owner') {
            const pageResult = await client.query<WorkflowActionStateRow>(
              `SELECT w.record, l.status, l.provider_reference, l.next_retry_at,
                      l.suppressed_count, l.failure_reason
               FROM workflow_actions w JOIN effects_ledger l ON l.action_id = w.id
               WHERE w.triage_case_id = $1 AND w.record->>'type' = 'page_on_call'
               FOR UPDATE OF w, l`,
              [claim.triageCaseId],
            );
            if (pageResult.rows[0]) {
              const page = mapWorkflowAction(pageResult.rows[0]);
              page.status = 'permanently_failed';
              page.failureReason = 'Owner assignment failed; page suppressed.';
              await this.saveActionState(transaction, page);
              await this.appendAttempt(
                transaction,
                page.id,
                1,
                'suppressed',
                now,
                null,
                page.failureReason,
              );
            }
          }
        } else {
          const delay = 2 ** (starts - 1);
          action.status = 'retry_scheduled';
          action.nextRetryAt = new Date(
            Date.now() + delay * 1000,
          ).toISOString();
          await this.appendAttempt(
            transaction,
            action.id,
            sequence,
            'transient_failure',
            now,
            providerReference,
            detail,
          );
          await this.enqueueAction(transaction, action, `${delay} seconds`);
        }
      }
      await this.saveActionState(transaction, action);
      await client.query(
        'UPDATE effects_ledger SET claim_token = NULL WHERE action_id = $1',
        [action.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async stop(): Promise<void> {
    await this.actionQueue.stop();
    await this.queue.stop();
    await this.pool.end();
  }
}

interface HealthRuntimeOptions {
  connectionString: string;
  clock: Clock;
  queueName?: string;
}

interface TriageRuntimeOptions {
  connectionString: string;
  clock: Clock;
  queueName?: string;
  queue?: TriageJobQueue;
}

interface TriageWorkerRuntimeOptions {
  connectionString: string;
  queueName?: string;
  clock?: Clock;
  pagingProvider?: PagingProviderPort<PageRequest>;
  assignmentProvider?: AssignmentProviderPort<AssignmentRequest>;
  claimLeaseMs?: number;
  afterProviderEffect?: (action: WorkflowAction) => Promise<void>;
  judgmentProvider?: OperationalJudgmentProviderPort<
    EvaluationInput,
    OperationalJudgments
  >;
}

export function createPostgresHealthSystem({
  connectionString,
  clock,
  queueName = HEALTH_CHECK_QUEUE,
}: HealthRuntimeOptions): PostgresHealthSystem {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossJobQueue(
    connectionString,
    queueName,
    HealthCheckMessageV1Schema,
  );
  return new PostgresHealthSystem(pool, queue, clock);
}

export function createPostgresHealthJobWorker({
  connectionString,
  clock,
  queueName = HEALTH_CHECK_QUEUE,
}: HealthRuntimeOptions): PgBossHealthJobWorker {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossJobQueue(
    connectionString,
    queueName,
    HealthCheckMessageV1Schema,
  );
  return new PgBossHealthJobWorker(pool, queue, clock);
}

export function createPostgresTriageSystem({
  connectionString,
  clock,
  queueName = TRIAGE_QUEUE,
  queue: providedQueue,
}: TriageRuntimeOptions): PostgresTriageSystem {
  const pool = new PostgresPool({ connectionString });
  const queue =
    providedQueue ??
    new PgBossJobQueue(connectionString, queueName, TriageJobMessageV1Schema);
  const actionQueue = new PgBossJobQueue(
    connectionString,
    `${queueName}-actions`,
    WorkflowActionJobMessageV1Schema,
  );
  return new PostgresTriageSystem(pool, queue, actionQueue, clock);
}

export function createPostgresTriageWorker({
  connectionString,
  queueName = TRIAGE_QUEUE,
  clock = { now: () => new Date() },
  pagingProvider = new SimulatedPagingProvider(),
  assignmentProvider = new SimulatedAssignmentProvider(),
  judgmentProvider = new DeterministicOperationalJudgmentProvider(),
  claimLeaseMs = 30_000,
  afterProviderEffect = async () => undefined,
}: TriageWorkerRuntimeOptions): PgBossTriageWorker {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossJobQueue(
    connectionString,
    queueName,
    TriageJobMessageV1Schema,
  );
  const actionQueue = new PgBossJobQueue(
    connectionString,
    `${queueName}-actions`,
    WorkflowActionJobMessageV1Schema,
  );
  return new PgBossTriageWorker(
    pool,
    queue,
    actionQueue,
    clock,
    pagingProvider,
    assignmentProvider,
    judgmentProvider,
    claimLeaseMs,
    afterProviderEffect,
  );
}
