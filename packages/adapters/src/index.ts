import { randomUUID } from 'node:crypto';

import type {
  HealthJobQueue,
  HealthSystem,
  TriageJobQueue,
  TriageSystem,
  TransactionalDatabase,
} from '@incident-command-center/application';
import {
  DeploymentEventIngestionResultSchema,
  CorroboratingFactSchema,
  EvaluationSchema,
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
  type HealthCheckJob,
  type HealthCheckMessageV1,
  type HealthStatus,
  type DeploymentEventIngestionResult,
  type DeploymentEventInput,
  type CorroboratingFact,
  type Evaluation,
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
  type TimelineEvent,
  type WorkflowAction,
} from '@incident-command-center/contracts';
import {
  decideAutomation,
  evaluateMonitoringAlertDeterministically,
  type Clock,
  type OperationalJudgmentProviderPort,
  type OperationalJudgmentResult,
  type PagingProviderPort,
} from '@incident-command-center/domain';
import type { Pool, PoolClient } from 'pg';
import { Pool as PostgresPool } from 'pg';
import { PgBoss, type Db } from 'pg-boss';

export const HEALTH_CHECK_QUEUE = 'system-health-check';
export const TRIAGE_QUEUE = 'triage-case-processing';
const WORKER_READY_WINDOW_MS = 15_000;
const APPLICATION_SCHEMA_LOCK = 740_219_350;

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
  source_type: 'monitoring_alert' | 'deployment_event';
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
  status: 'queued' | 'ready_for_evaluation' | 'incident_created';
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
  occurredAt: string;
  service: string;
  environment: string | null;
  region: string | null;
  title: string | null;
  content: string | null;
  facts: unknown;
  rawFixtureReference: string | null;
}

const schemaSql = `
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
    source_type text NOT NULL CHECK (source_type IN ('monitoring_alert', 'deployment_event')),
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
    CHECK (source_type IN ('monitoring_alert', 'deployment_event'));
  ALTER TABLE triage_cases DROP CONSTRAINT IF EXISTS triage_cases_status_check;
  ALTER TABLE triage_cases ADD CONSTRAINT triage_cases_status_check
    CHECK (status IN ('queued', 'ready_for_evaluation', 'incident_created'));

  CREATE TABLE IF NOT EXISTS evaluations (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
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

  CREATE TABLE IF NOT EXISTS workflow_actions (
    id uuid PRIMARY KEY,
    triage_case_id uuid NOT NULL REFERENCES triage_cases(id),
    incident_id uuid REFERENCES incidents(id),
    idempotency_key text NOT NULL UNIQUE,
    record jsonb NOT NULL
  );

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
    options: { id: string; transaction: TransactionalDatabase },
  ): Promise<void> {
    await this.#boss.send(this.name, this.messageSchema.parse(message), {
      id: options.id,
      db: options.transaction as Db,
      retryLimit: 3,
      retryDelay: 1,
      retryBackoff: true,
      deleteAfterSeconds: 0,
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
          input.occurredAt,
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
      factResult,
      policyResult,
      actionResult,
      incidentResult,
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
        "SELECT record FROM corroborating_facts WHERE triage_case_id = $1 ORDER BY record->>'kind'",
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM policy_decisions WHERE triage_case_id = $1
           ORDER BY record->>'decidedAt' DESC LIMIT 1`,
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM workflow_actions WHERE triage_case_id = $1
           ORDER BY CASE record->>'type'
             WHEN 'create_incident' THEN 1 WHEN 'assign_owner' THEN 2 ELSE 3 END`,
        [id],
      ),
      this.pool.query<{ id: string }>(
        'SELECT id FROM incidents WHERE triage_case_id = $1',
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM timeline_events
           WHERE incident_id = (SELECT id FROM incidents WHERE triage_case_id = $1)
           ORDER BY CASE record->>'type'
             WHEN 'incident_created' THEN 1 WHEN 'owner_assigned' THEN 2 ELSE 3 END`,
        [id],
      ),
    ]);

    return TriageCaseDetailSchema.parse({
      triageCase: mapTriageCase(triageRow),
      signal: mapSignal(signalResult.rows[0]!),
      evaluation: evaluationResult.rows[0]?.record ?? null,
      corroboratingFacts: factResult.rows.map((row) => row.record),
      policyDecision: policyResult.rows[0]?.record ?? null,
      workflowActions: actionResult.rows.map((row) => row.record),
      timelineEvents: timelineResult.rows.map((row) => row.record),
      incidentId: incidentResult.rows[0]?.id ?? null,
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
      factResult,
      policyResult,
      actionResult,
      timelineResult,
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
        "SELECT record FROM corroborating_facts WHERE triage_case_id = $1 ORDER BY record->>'kind'",
        [incidentRow.triage_case_id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM policy_decisions WHERE triage_case_id = $1
           ORDER BY record->>'decidedAt' DESC LIMIT 1`,
        [incidentRow.triage_case_id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM workflow_actions WHERE incident_id = $1
           ORDER BY CASE record->>'type'
             WHEN 'create_incident' THEN 1 WHEN 'assign_owner' THEN 2 ELSE 3 END`,
        [id],
      ),
      this.pool.query<{ record: unknown }>(
        `SELECT record FROM timeline_events WHERE incident_id = $1
           ORDER BY CASE record->>'type'
             WHEN 'incident_created' THEN 1 WHEN 'owner_assigned' THEN 2 ELSE 3 END`,
        [id],
      ),
    ]);

    return IncidentDetailSchema.parse({
      incident: incidentRow.record,
      signal: mapSignal(signalResult.rows[0]!),
      evaluation: evaluationResult.rows[0]!.record,
      corroboratingFacts: factResult.rows.map((row) => row.record),
      policyDecision: policyResult.rows[0]!.record,
      workflowActions: actionResult.rows.map((row) => row.record),
      timelineEvents: timelineResult.rows.map((row) => row.record),
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

class DeterministicOperationalJudgmentProvider implements OperationalJudgmentProviderPort<
  MonitoringAlertInput,
  OperationalJudgments
> {
  async evaluate(
    signal: MonitoringAlertInput,
  ): Promise<OperationalJudgmentResult<OperationalJudgments>> {
    return {
      judgments: evaluateMonitoringAlertDeterministically(signal),
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
    private readonly clock: Clock,
    private readonly pagingProvider: PagingProviderPort<PageRequest>,
    private readonly judgmentProvider: OperationalJudgmentProviderPort<
      MonitoringAlertInput,
      OperationalJudgments
    >,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
    await this.queue.process(async (message, transaction) => {
      await this.process(message, transaction);
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

    const completedResult = await transaction.executeSql(
      'SELECT 1 FROM policy_decisions WHERE triage_case_id = $1 LIMIT 1',
      [message.triageCaseId],
    );
    if (completedResult.rows.length > 0) return;

    if (signal.sourceType === 'deployment_event') {
      await transaction.executeSql(
        `UPDATE triage_cases
         SET status = 'ready_for_evaluation'
         WHERE id = $1 AND signal_id = $2`,
        [message.triageCaseId, message.signalId],
      );
      return;
    }

    const judgmentResult = await this.judgmentProvider.evaluate({
      provider: signal.provider,
      sourceEventKey: signal.sourceEventKey,
      sourceReference: signal.sourceReference,
      metric: signal.facts.metric,
      threshold: signal.facts.threshold,
      observedValue: signal.facts.observedValue,
      service: signal.service,
      region: signal.region as 'us-east' | 'eu-west' | 'sa-east',
      occurredAt: signal.occurredAt,
      evaluationWindowSeconds: signal.facts.evaluationWindowSeconds,
      ...(signal.environment ? { environment: signal.environment } : {}),
      ...(signal.title ? { title: signal.title } : {}),
      ...(signal.content ? { content: signal.content } : {}),
      ...(signal.rawFixtureReference
        ? { rawFixtureReference: signal.rawFixtureReference }
        : {}),
    });
    const { judgments } = judgmentResult;
    const occurredAt = new Date(signal.occurredAt);
    const recentDeploymentResult = await transaction.executeSql(
      `SELECT id FROM signals
       WHERE source_type = 'deployment_event'
         AND service = $1 AND region = $2
         AND facts->>'outcome' = 'succeeded'
         AND occurred_at <= $3
         AND occurred_at >= $3::timestamptz - interval '15 minutes'
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [signal.service, signal.region, occurredAt],
    );
    const corroboratingFacts: CorroboratingFact[] = [];
    if (signal.facts.observedValue > signal.facts.threshold) {
      corroboratingFacts.push(
        CorroboratingFactSchema.parse({
          id: randomUUID(),
          kind: 'threshold_breach',
          summary: `${signal.facts.metric} measured ${signal.facts.observedValue} against threshold ${signal.facts.threshold}.`,
          evidenceSignalIds: [signal.id],
        }),
      );
    }
    const recentDeployment = recentDeploymentResult.rows[0] as
      { id: string } | undefined;
    const thresholdBreached =
      signal.facts.observedValue > signal.facts.threshold;
    if (recentDeployment && thresholdBreached) {
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

    const evaluatedAt = this.clock.now().toISOString();
    const evaluation = EvaluationSchema.parse({
      id: randomUUID(),
      triageCaseId: message.triageCaseId,
      previousEvaluationId: null,
      correlationId: message.correlationId,
      status: 'succeeded',
      configuredModel: judgmentResult.configuredModel,
      resolvedModel: judgmentResult.resolvedModel,
      normalizationVersion: 1,
      decisionSchemaVersion: 'operational-judgments.v1',
      questionSetVersion: 'northstar-triage.v1',
      policyVersion: 'northstar-automation.v1',
      attemptId: randomUUID(),
      providerRequestId: judgmentResult.providerRequestId,
      inputTokens: judgmentResult.inputTokens,
      outputTokens: judgmentResult.outputTokens,
      latencyMs: judgmentResult.latencyMs,
      retryCount: judgmentResult.retryCount,
      evaluatedAt,
      judgments,
    });
    const automation = decideAutomation(
      judgments,
      corroboratingFacts.length > 0,
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

    if (!automation.authorizedActions.includes('create_incident')) {
      await transaction.executeSql(
        `UPDATE triage_cases SET status = 'ready_for_evaluation'
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
      primaryOwningDomain: judgments.primaryOwningDomain.choice,
      createdAt: evaluatedAt,
      correlationId: message.correlationId,
    });
    await transaction.executeSql(
      'INSERT INTO incidents (id, triage_case_id, record) VALUES ($1, $2, $3::jsonb)',
      [incident.id, message.triageCaseId, JSON.stringify(incident)],
    );

    await this.recordAction(
      transaction,
      message.triageCaseId,
      incident,
      'create_incident',
      `workflow:create_incident:${message.triageCaseId}`,
      null,
      'incident_created',
      'Incident created open from the authorized Policy Decision.',
      evaluatedAt,
    );
    if (automation.authorizedActions.includes('assign_owner')) {
      await this.recordAction(
        transaction,
        message.triageCaseId,
        incident,
        'assign_owner',
        `workflow:assign_owner:${message.triageCaseId}:northstar-automation.v1`,
        null,
        'owner_assigned',
        `${incident.primaryOwningDomain} assigned as Primary Owning Domain.`,
        evaluatedAt,
      );
    }
    if (automation.authorizedActions.includes('page_on_call')) {
      const idempotencyKey = `workflow:page_on_call:${message.triageCaseId}:northstar-automation.v1`;
      const page = PageRequestSchema.parse({
        incidentId: incident.id,
        correlationId: message.correlationId,
        priority: incident.currentPriority,
        owningDomain: incident.primaryOwningDomain,
        summary: incident.title,
        idempotencyKey,
      });
      const result = await this.pagingProvider.page(page);
      await this.recordAction(
        transaction,
        message.triageCaseId,
        incident,
        'page_on_call',
        idempotencyKey,
        result.providerReference,
        'on_call_paged',
        `${incident.primaryOwningDomain} On-call Engineer paged.`,
        evaluatedAt,
      );
    }

    await transaction.executeSql(
      `UPDATE triage_cases SET status = 'incident_created'
       WHERE id = $1 AND signal_id = $2`,
      [message.triageCaseId, message.signalId],
    );
  }

  private async recordAction(
    transaction: TransactionalDatabase,
    triageCaseId: string,
    incident: Incident,
    type: WorkflowAction['type'],
    idempotencyKey: string,
    providerReference: string | null,
    timelineType: TimelineEvent['type'],
    summary: string,
    occurredAt: string,
  ): Promise<void> {
    const action = WorkflowActionSchema.parse({
      id: randomUUID(),
      correlationId: incident.correlationId,
      type,
      status: 'succeeded',
      idempotencyKey,
      providerReference,
      attempts: [
        {
          id: randomUUID(),
          attemptedAt: occurredAt,
          outcome: 'succeeded',
          providerReference,
        },
      ],
    });
    const timelineEvent = TimelineEventSchema.parse({
      id: randomUUID(),
      correlationId: incident.correlationId,
      type: timelineType,
      occurredAt,
      summary,
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
        JSON.stringify(action),
      ],
    );
    await transaction.executeSql(
      'INSERT INTO timeline_events (id, incident_id, record) VALUES ($1, $2, $3::jsonb)',
      [timelineEvent.id, incident.id, JSON.stringify(timelineEvent)],
    );
  }

  async stop(): Promise<void> {
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
  judgmentProvider?: OperationalJudgmentProviderPort<
    MonitoringAlertInput,
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
  return new PostgresTriageSystem(pool, queue, clock);
}

export function createPostgresTriageWorker({
  connectionString,
  queueName = TRIAGE_QUEUE,
  clock = { now: () => new Date() },
  pagingProvider = new SimulatedPagingProvider(),
  judgmentProvider = new DeterministicOperationalJudgmentProvider(),
}: TriageWorkerRuntimeOptions): PgBossTriageWorker {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossJobQueue(
    connectionString,
    queueName,
    TriageJobMessageV1Schema,
  );
  return new PgBossTriageWorker(
    pool,
    queue,
    clock,
    pagingProvider,
    judgmentProvider,
  );
}
