import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  HEALTH_CHECK_QUEUE,
  createPostgresHealthJobWorker,
  createPostgresHealthSystem,
} from '@incident-command-center/adapters';
import {
  HealthCheckJobSchema,
  HealthStatusSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('health job round trip', () => {
  const apiClock = new ManualClock('2026-09-21T12:00:00.000Z');
  const workerClock = new ManualClock('2026-09-21T12:00:05.000Z');
  const correlationId = randomUUID();
  const queueName = `${HEALTH_CHECK_QUEUE}-${randomUUID()}`;
  let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
  let worker: ReturnType<typeof createPostgresHealthJobWorker>;
  let api: Awaited<ReturnType<typeof buildApi>>;

  beforeAll(async () => {
    healthSystem = createPostgresHealthSystem({
      connectionString: databaseUrl!,
      clock: apiClock,
      queueName,
    });
    await healthSystem.start();

    worker = createPostgresHealthJobWorker({
      connectionString: databaseUrl!,
      clock: workerClock,
      queueName,
    });
    await worker.start();

    api = await buildApi({
      healthSystem,
      allowedOrigin: 'http://localhost:3000',
      logger: false,
    });
  });

  afterAll(async () => {
    await api?.close();
    await worker?.stop();
    await healthSystem?.stop();
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
          queue: queueName,
        },
      });
  });
});
