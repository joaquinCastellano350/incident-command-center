import { randomUUID } from 'node:crypto';

import type { HealthSystem } from '@incident-command-center/application';
import {
  HealthCheckJobSchema,
  type HealthCheckJob,
  type HealthStatus,
} from '@incident-command-center/contracts';
import type { Clock } from '@incident-command-center/domain';
import type { Pool, PoolClient } from 'pg';
import { PgBoss, type Db, type Job } from 'pg-boss';

export const HEALTH_CHECK_QUEUE = 'system-health-check';
const WORKER_NAME = 'health-worker';
const WORKER_READY_WINDOW_MS = 15_000;

interface HealthJobPayload {
  healthJobId: string;
}

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

function clientDatabase(client: PoolClient): Db {
  return {
    async executeSql(text, values = []) {
      return client.query(text, values);
    },
  };
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
    private readonly boss: PgBoss,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    this.boss.on('error', (error) => {
      console.error('pg-boss error', error);
    });
    await this.boss.start();
    await this.boss.createQueue(HEALTH_CHECK_QUEUE, { notify: true });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async readiness(): Promise<HealthStatus> {
    const checkedAt = this.clock.now();

    try {
      await this.pool.query('SELECT 1');
      const heartbeat = await this.pool.query<{ observed_at: Date }>(
        `SELECT observed_at
         FROM worker_heartbeats
         WHERE worker_name = $1`,
        [WORKER_NAME],
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

      await this.boss.send(
        HEALTH_CHECK_QUEUE,
        { healthJobId: id } satisfies HealthJobPayload,
        {
          id,
          db: clientDatabase(client),
          retryLimit: 3,
          retryDelay: 1,
          retryBackoff: true,
          deleteAfterSeconds: 86_400,
        },
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
    private readonly boss: PgBoss,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
    this.boss.on('error', (error) => {
      console.error('pg-boss worker error', error);
    });
    await this.boss.start();
    await this.boss.createQueue(HEALTH_CHECK_QUEUE, { notify: true });
    await this.recordHeartbeat();

    this.#heartbeatTimer = setInterval(() => {
      void this.recordHeartbeat();
    }, 5_000);
    this.#heartbeatTimer.unref();

    await this.boss.work(
      HEALTH_CHECK_QUEUE,
      {
        transactional: true,
        pollingIntervalSeconds: 0.5,
      },
      async (jobs: Job<HealthJobPayload>[], transaction: Db) => {
        await this.complete(jobs, transaction);
      },
    );
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
    }
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  private async complete(
    jobs: Job<HealthJobPayload>[],
    transaction: Db,
  ): Promise<void> {
    const job = jobs[0];
    if (!job) {
      return;
    }

    await transaction.executeSql(
      `UPDATE health_check_jobs
       SET status = 'completed', completed_at = $2, result = $3::jsonb
       WHERE id = $1`,
      [
        job.data.healthJobId,
        this.clock.now(),
        JSON.stringify({
          message: 'Durable health check completed',
          queue: HEALTH_CHECK_QUEUE,
        }),
      ],
    );
  }

  private async recordHeartbeat(): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_heartbeats (worker_name, observed_at)
       VALUES ($1, $2)
       ON CONFLICT (worker_name)
       DO UPDATE SET observed_at = EXCLUDED.observed_at`,
      [WORKER_NAME, this.clock.now()],
    );
  }
}
