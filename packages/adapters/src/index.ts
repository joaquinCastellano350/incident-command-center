import { randomUUID } from 'node:crypto';

import type {
  HealthJobQueue,
  HealthSystem,
  TriageJobQueue,
  TriageSystem,
  TransactionalDatabase,
} from '@incident-command-center/application';
import {
  HealthCheckJobSchema,
  HealthCheckMessageV1Schema,
  MonitoringAlertIngestionResultSchema,
  SignalSchema,
  TriageCaseSchema,
  TriageJobMessageV1Schema,
  type HealthCheckJob,
  type HealthCheckMessageV1,
  type HealthStatus,
  type MonitoringAlertIngestionResult,
  type MonitoringAlertInput,
  type Signal,
  type TriageCase,
  type TriageJobMessageV1,
} from '@incident-command-center/contracts';
import type { Clock } from '@incident-command-center/domain';
import type { Pool, PoolClient } from 'pg';
import { Pool as PostgresPool } from 'pg';
import { PgBoss, type Db } from 'pg-boss';

export const HEALTH_CHECK_QUEUE = 'system-health-check';
export const TRIAGE_QUEUE = 'triage-case-processing';
const WORKER_READY_WINDOW_MS = 15_000;

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
  source_type: 'monitoring_alert';
  provider: string;
  source_event_key: string;
  source_reference: string;
  occurred_at: Date;
  received_at: Date;
  service: string;
  environment: string | null;
  region: string | null;
  title: string;
  content: string | null;
  facts: unknown;
  normalization_version: 1;
  raw_fixture_reference: string | null;
  correlation_id: string;
}

interface TriageCaseRow {
  id: string;
  signal_id: string;
  status: 'queued' | 'ready_for_evaluation';
  source_reference: string;
  service: string;
  region: string | null;
  received_at: Date;
  correlation_id: string;
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
    source_type text NOT NULL CHECK (source_type = 'monitoring_alert'),
    provider text NOT NULL,
    source_event_key text NOT NULL,
    source_reference text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    service text NOT NULL,
    environment text,
    region text,
    title text NOT NULL,
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
`;

export async function ensureApplicationSchema(pool: Pool): Promise<void> {
  await pool.query(schemaSql);
}

function clientDatabase(client: PoolClient): TransactionalDatabase {
  return {
    async executeSql(text, values = []) {
      return client.query(text, values);
    },
  };
}

class PgBossHealthJobQueue implements HealthJobQueue {
  readonly #boss: PgBoss;

  constructor(
    connectionString: string,
    readonly name: string,
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
    message: HealthCheckMessageV1,
    options: { id: string; transaction: TransactionalDatabase },
  ): Promise<void> {
    await this.#boss.send(
      this.name,
      HealthCheckMessageV1Schema.parse(message),
      {
        id: options.id,
        db: options.transaction as Db,
        retryLimit: 3,
        retryDelay: 1,
        retryBackoff: true,
        deleteAfterSeconds: 0,
      },
    );
  }

  async process(
    handler: (
      message: HealthCheckMessageV1,
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
          await handler(
            HealthCheckMessageV1Schema.parse(job.data),
            transaction,
          );
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

class PgBossTriageJobQueue implements TriageJobQueue {
  readonly #boss: PgBoss;

  constructor(
    connectionString: string,
    readonly name: string,
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
    message: TriageJobMessageV1,
    options: { id: string; transaction: TransactionalDatabase },
  ): Promise<void> {
    await this.#boss.send(this.name, TriageJobMessageV1Schema.parse(message), {
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
      message: TriageJobMessageV1,
      transaction: TransactionalDatabase,
    ) => Promise<void>,
  ): Promise<void> {
    await this.#boss.work(
      this.name,
      { transactional: true, pollingIntervalSeconds: 0.5 },
      async (jobs, transaction) => {
        const job = jobs[0];
        if (job) {
          await handler(TriageJobMessageV1Schema.parse(job.data), transaction);
        }
      },
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
           $1, 'monitoring_alert', $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12::jsonb, 1, $13, $14
         )
         ON CONFLICT (provider, source_event_key) DO NOTHING
         RETURNING *`,
        [
          signalId,
          input.provider,
          input.sourceEventKey,
          input.sourceReference,
          input.occurredAt,
          receivedAt,
          input.service,
          input.environment ?? null,
          input.region,
          input.title ?? `${input.metric} crossed its threshold`,
          input.content ?? null,
          JSON.stringify({
            metric: input.metric,
            threshold: input.threshold,
            observedValue: input.observedValue,
            evaluationWindowSeconds: input.evaluationWindowSeconds,
          }),
          input.rawFixtureReference ?? null,
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

        return MonitoringAlertIngestionResultSchema.parse({
          signal: mapSignal(duplicateSignal.rows[0]!),
          triageCase: mapTriageCase(duplicateCase.rows[0]!),
          deduplicated: true,
        });
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

      return MonitoringAlertIngestionResultSchema.parse({
        signal: mapSignal(signalRow),
        triageCase: mapTriageCase(insertedCase.rows[0]!),
        deduplicated: false,
      });
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
}

export class PgBossTriageWorker {
  constructor(
    private readonly pool: Pool,
    private readonly queue: TriageJobQueue,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    await this.queue.start();
    await this.queue.process(async (message, transaction) => {
      await transaction.executeSql(
        `UPDATE triage_cases
         SET status = 'ready_for_evaluation'
         WHERE id = $1 AND signal_id = $2`,
        [message.triageCaseId, message.signalId],
      );

      console.info(
        JSON.stringify({
          event: 'triage_case.ready_for_evaluation',
          triageCaseId: message.triageCaseId,
          signalId: message.signalId,
          correlationId: message.correlationId,
        }),
      );
    });
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

export function createPostgresHealthSystem({
  connectionString,
  clock,
  queueName = HEALTH_CHECK_QUEUE,
}: HealthRuntimeOptions): PostgresHealthSystem {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossHealthJobQueue(connectionString, queueName);
  return new PostgresHealthSystem(pool, queue, clock);
}

export function createPostgresHealthJobWorker({
  connectionString,
  clock,
  queueName = HEALTH_CHECK_QUEUE,
}: HealthRuntimeOptions): PgBossHealthJobWorker {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossHealthJobQueue(connectionString, queueName);
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
    providedQueue ?? new PgBossTriageJobQueue(connectionString, queueName);
  return new PostgresTriageSystem(pool, queue, clock);
}

export function createPostgresTriageWorker({
  connectionString,
  queueName = TRIAGE_QUEUE,
}: Omit<TriageRuntimeOptions, 'clock'>): PgBossTriageWorker {
  const pool = new PostgresPool({ connectionString });
  const queue = new PgBossTriageJobQueue(connectionString, queueName);
  return new PgBossTriageWorker(pool, queue);
}
