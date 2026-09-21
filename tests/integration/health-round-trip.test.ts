import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  HEALTH_CHECK_QUEUE,
  PgBossHealthJobWorker,
  PostgresHealthSystem,
} from '@incident-command-center/adapters';
import {
  HealthCheckJobSchema,
  HealthStatusSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';
import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('health job round trip', () => {
  const clock = new ManualClock('2026-09-21T12:00:00.000Z');
  const correlationId = randomUUID();
  let pool: Pool;
  let apiBoss: PgBoss;
  let workerBoss: PgBoss;
  let healthSystem: PostgresHealthSystem;
  let worker: PgBossHealthJobWorker;
  let api: Awaited<ReturnType<typeof buildApi>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    apiBoss = new PgBoss({ connectionString: databaseUrl! });
    workerBoss = new PgBoss({ connectionString: databaseUrl! });
    healthSystem = new PostgresHealthSystem(pool, apiBoss, clock);
    await healthSystem.start();

    worker = new PgBossHealthJobWorker(pool, workerBoss, clock);
    await worker.start();

    api = await buildApi({
      healthSystem,
      clock,
      allowedOrigin: 'http://localhost:3000',
    });
  });

  afterAll(async () => {
    await api?.close();
    await worker?.stop();
    await healthSystem?.stop();
    await pool?.end();
  });

  it('persists a submitted job, lets the worker complete it, and exposes the result', async () => {
    const healthResponse = await api.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    const health = HealthStatusSchema.parse(healthResponse.json());

    expect(healthResponse.statusCode).toBe(200);
    expect(health).toMatchObject({
      status: 'ready',
      api: 'ready',
      database: 'ready',
      worker: 'ready',
      checkedAt: '2026-09-21T12:00:00.000Z',
    });

    const submitResponse = await api.inject({
      method: 'POST',
      url: '/api/v1/health-jobs',
      headers: { 'x-correlation-id': correlationId },
    });
    const submitted = HealthCheckJobSchema.parse(submitResponse.json());

    expect(submitResponse.statusCode).toBe(202);
    expect(submitted).toMatchObject({
      status: 'queued',
      correlationId,
      requestedAt: '2026-09-21T12:00:00.000Z',
      completedAt: null,
      result: null,
    });

    clock.set('2026-09-21T12:00:05.000Z');

    await expect
      .poll(
        async () => {
          const response = await api.inject({
            method: 'GET',
            url: `/api/v1/health-jobs/${submitted.id}`,
          });
          return HealthCheckJobSchema.parse(response.json());
        },
        { timeout: 15_000, interval: 100 },
      )
      .toMatchObject({
        id: submitted.id,
        status: 'completed',
        correlationId,
        requestedAt: '2026-09-21T12:00:00.000Z',
        completedAt: '2026-09-21T12:00:05.000Z',
        result: {
          message: 'Durable health check completed',
          queue: HEALTH_CHECK_QUEUE,
        },
      });
  });
});
