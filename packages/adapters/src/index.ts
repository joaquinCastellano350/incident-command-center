import { randomUUID } from 'node:crypto';

import type {
  HealthJobQueue,
  HealthSystem,
  TransactionalDatabase,
} from '@incident-command-center/application';
import {
  HealthCheckJobSchema,
  HealthCheckMessageV1Schema,
  type HealthCheckJob,
  type HealthCheckMessageV1,
  type HealthStatus,
} from '@incident-command-center/contracts';
import type { Clock } from '@incident-command-center/domain';
import type { Pool, PoolClient } from 'pg';
import { Pool as PostgresPool } from 'pg';
import { PgBoss, type Db } from 'pg-boss';

export const HEALTH_CHECK_QUEUE = 'system-health-check';
const WORKER_READY_WINDOW_MS = 15_000;

interface HealthJobRow {
  id: string;
  status: 'queued' | 'completed';
  correlation_id: string;
  requested_at: Date;
  completed_at: Date | null;
  result: unknown | null;
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

interface HealthRuntimeOptions {
  connectionString: string;
  clock: Clock;
  queueName?: string;
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
