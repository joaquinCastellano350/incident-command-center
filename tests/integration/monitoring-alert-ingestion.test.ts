import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  TRIAGE_QUEUE,
  createPostgresHealthSystem,
  createPostgresTriageWorker,
  createPostgresTriageSystem,
} from '@incident-command-center/adapters';
import {
  MonitoringAlertIngestionResultSchema,
  TriageQueueSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('Monitoring Alert ingestion', () => {
  const receiptClock = new ManualClock('2026-09-21T12:04:00.000Z');
  const queueName = `${TRIAGE_QUEUE}-${randomUUID()}`;
  const sourceEventKey = `alert-checkout-auth-failures-${randomUUID()}`;
  let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
  let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
  let api: Awaited<ReturnType<typeof buildApi>>;

  beforeAll(async () => {
    healthSystem = createPostgresHealthSystem({
      connectionString: databaseUrl!,
      clock: receiptClock,
      queueName: `health-${randomUUID()}`,
    });
    await healthSystem.start();

    triageSystem = createPostgresTriageSystem({
      connectionString: databaseUrl!,
      clock: receiptClock,
      queueName,
    });
    await triageSystem.start();

    api = await buildApi({
      healthSystem,
      triageSystem,
      allowedOrigin: 'http://localhost:3000',
      logger: false,
    });
  });

  afterAll(async () => {
    await api?.close();
    await triageSystem?.stop();
    await healthSystem?.stop();
  });

  it.each([
    ['provider', ''],
    ['sourceEventKey', ''],
    ['sourceReference', ''],
    ['metric', ''],
    ['threshold', 'not-a-number'],
    ['observedValue', 'not-a-number'],
    ['service', ''],
    ['region', 'unknown-region'],
    ['occurredAt', 'not-a-date'],
    ['evaluationWindowSeconds', 0],
  ])('rejects an invalid %s before ingestion', async (field, invalidValue) => {
    const payload: Record<string, unknown> = {
      provider: 'northstar-monitoring',
      sourceEventKey: `invalid-${field}-${randomUUID()}`,
      sourceReference: 'mon-invalid',
      metric: 'request_error_rate',
      threshold: 5,
      observedValue: 12,
      service: 'api-gateway',
      region: 'us-east',
      occurredAt: '2026-09-21T12:00:00.000Z',
      evaluationWindowSeconds: 300,
    };
    payload[field] = invalidValue;

    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Invalid Monitoring Alert',
    });
  });

  it('normalizes an accepted alert and exposes its queued Triage Case', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      headers: { 'x-correlation-id': randomUUID() },
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey,
        sourceReference: 'mon-8472',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: '2026-09-21T12:00:00.000Z',
        evaluationWindowSeconds: 600,
      },
    });

    const accepted = MonitoringAlertIngestionResultSchema.parse(
      response.json(),
    );

    expect(response.statusCode).toBe(202);
    expect(accepted).toMatchObject({
      deduplicated: false,
      signal: {
        sourceType: 'monitoring_alert',
        provider: 'northstar-monitoring',
        sourceEventKey,
        sourceReference: 'mon-8472',
        occurredAt: '2026-09-21T12:00:00.000Z',
        receivedAt: '2026-09-21T12:04:00.000Z',
        service: 'checkout-api',
        environment: null,
        region: 'us-east',
        content: null,
        rawFixtureReference: null,
        normalizationVersion: 1,
        facts: {
          metric: 'payment_authorization_failure_rate',
          threshold: 2,
          observedValue: 18,
          evaluationWindowSeconds: 600,
        },
      },
      triageCase: {
        status: 'queued',
        sourceReference: 'mon-8472',
        service: 'checkout-api',
        region: 'us-east',
        receivedAt: '2026-09-21T12:04:00.000Z',
      },
    });
    expect(accepted.triageCase.signalId).toBe(accepted.signal.id);

    const queueResponse = await api.inject({
      method: 'GET',
      url: '/api/v1/triage-cases',
    });
    const queue = TriageQueueSchema.parse(queueResponse.json());

    expect(queueResponse.statusCode).toBe(200);
    expect(queue.items).toContainEqual(accepted.triageCase);
  });

  it('returns the original Signal and Triage Case when the provider event is replayed', async () => {
    const queueBefore = TriageQueueSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/v1/triage-cases' })).json(),
    );
    const payload = {
      provider: 'northstar-monitoring',
      sourceEventKey: `replay-${randomUUID()}`,
      sourceReference: 'mon-replay',
      metric: 'request_error_rate',
      threshold: 5,
      observedValue: 12,
      service: 'event-router',
      region: 'eu-west',
      occurredAt: '2026-09-21T12:01:00.000Z',
      evaluationWindowSeconds: 300,
    };

    const firstResponse = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload,
    });
    const replayResponse = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload,
    });
    const first = MonitoringAlertIngestionResultSchema.parse(
      firstResponse.json(),
    );
    const replay = MonitoringAlertIngestionResultSchema.parse(
      replayResponse.json(),
    );
    const queueAfter = TriageQueueSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/v1/triage-cases' })).json(),
    );

    expect(firstResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(200);
    expect(first.deduplicated).toBe(false);
    expect(replay).toEqual({ ...first, deduplicated: true });
    expect(queueAfter.items).toHaveLength(queueBefore.items.length + 1);
    expect(
      queueAfter.items.filter(
        (triageCase) => triageCase.id === first.triageCase.id,
      ),
    ).toHaveLength(1);
  });

  it('rolls back the Signal and Triage Case when durable enqueue fails', async () => {
    const sourceReference = `mon-rollback-${randomUUID()}`;
    const failingTriageSystem = createPostgresTriageSystem({
      connectionString: databaseUrl!,
      clock: receiptClock,
      queue: {
        name: `failing-${randomUUID()}`,
        async start() {},
        async stop() {},
        async enqueue() {
          throw new Error('durable queue unavailable');
        },
        async process() {},
      },
    });
    await failingTriageSystem.start();
    const failingApi = await buildApi({
      healthSystem,
      triageSystem: failingTriageSystem,
      allowedOrigin: 'http://localhost:3000',
      logger: false,
    });

    try {
      const response = await failingApi.inject({
        method: 'POST',
        url: '/api/v1/signals/monitoring-alerts',
        payload: {
          provider: 'northstar-monitoring',
          sourceEventKey: `rollback-${randomUUID()}`,
          sourceReference,
          metric: 'request_error_rate',
          threshold: 5,
          observedValue: 12,
          service: 'event-router',
          region: 'eu-west',
          occurredAt: '2026-09-21T12:01:00.000Z',
          evaluationWindowSeconds: 300,
        },
      });
      const queueResponse = await failingApi.inject({
        method: 'GET',
        url: '/api/v1/triage-cases',
      });
      const queue = TriageQueueSchema.parse(queueResponse.json());

      expect(response.statusCode).toBe(500);
      expect(
        queue.items.some(
          (triageCase) => triageCase.sourceReference === sourceReference,
        ),
      ).toBe(false);
    } finally {
      await failingApi.close();
      await failingTriageSystem.stop();
    }
  });

  it('advances the Triage Case status through durable worker processing', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: `worker-status-${randomUUID()}`,
        sourceReference: 'mon-worker-status',
        metric: 'request_error_rate',
        threshold: 5,
        observedValue: 12,
        service: 'api-gateway',
        region: 'us-east',
        occurredAt: '2026-09-21T12:01:00.000Z',
        evaluationWindowSeconds: 300,
      },
    });
    const accepted = MonitoringAlertIngestionResultSchema.parse(
      response.json(),
    );
    const worker = createPostgresTriageWorker({
      connectionString: databaseUrl!,
      queueName,
    });

    await worker.start();
    try {
      await expect
        .poll(
          async () => {
            const queueResponse = await api.inject({
              method: 'GET',
              url: '/api/v1/triage-cases',
            });
            const queue = TriageQueueSchema.parse(queueResponse.json());
            return queue.items.find(
              (triageCase) => triageCase.id === accepted.triageCase.id,
            )?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe('ready_for_evaluation');
    } finally {
      await worker.stop();
    }
  });

  it('streams the worker-updated Triage Queue over Server-Sent Events', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: `sse-status-${randomUUID()}`,
        sourceReference: 'mon-sse-status',
        metric: 'request_latency_ms',
        threshold: 750,
        observedValue: 1400,
        service: 'checkout-api',
        region: 'sa-east',
        occurredAt: '2026-09-21T12:02:00.000Z',
        evaluationWindowSeconds: 300,
      },
    });
    const accepted = MonitoringAlertIngestionResultSchema.parse(
      response.json(),
    );
    const worker = createPostgresTriageWorker({
      connectionString: databaseUrl!,
      queueName,
    });

    await worker.start();
    try {
      await expect
        .poll(
          async () => {
            const queueResponse = await api.inject({
              method: 'GET',
              url: '/api/v1/triage-cases',
            });
            return TriageQueueSchema.parse(queueResponse.json()).items.find(
              (triageCase) => triageCase.id === accepted.triageCase.id,
            )?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe('ready_for_evaluation');
    } finally {
      await worker.stop();
    }

    const eventResponse = await api.inject({
      method: 'GET',
      url: '/api/v1/triage-cases/events?once=true',
    });
    const dataLine = eventResponse.body
      .split('\n')
      .find((line) => line.startsWith('data: '));
    const queue = TriageQueueSchema.parse(
      JSON.parse(dataLine?.slice('data: '.length) ?? 'null'),
    );

    expect(eventResponse.statusCode).toBe(200);
    expect(eventResponse.headers['content-type']).toContain(
      'text/event-stream',
    );
    expect(queue.items).toContainEqual({
      ...accepted.triageCase,
      status: 'ready_for_evaluation',
    });
  });
});
