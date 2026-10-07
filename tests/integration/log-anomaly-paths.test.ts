import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/app.js';
import {
  TRIAGE_QUEUE,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import {
  IncidentDetailSchema,
  LogAnomalyIngestionResultSchema,
  TriageCaseDetailSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('Log Anomaly ingestion to query', () => {
  const clock = new ManualClock('2026-09-21T12:05:00.000Z');
  const queueName = `${TRIAGE_QUEUE}-${randomUUID()}`;
  const databaseName = `incident_test_${randomUUID().replaceAll('-', '_')}`;
  const adminUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  adminUrl.pathname = '/postgres';
  const isolatedUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
  let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
  let worker: ReturnType<typeof createPostgresTriageWorker>;
  let api: Awaited<ReturnType<typeof buildApi>>;

  const payload = (
    service: string,
    occurrenceCount: number,
    samples: string[],
  ) => ({
    provider: 'northstar-logs',
    sourceEventKey: randomUUID(),
    sourceReference: `logs-${service}-${occurrenceCount}`,
    service,
    region: 'us-east',
    errorSignature: 'PaymentAuthorizationTimeout',
    occurrenceCount,
    sampleMessages: samples,
    windowStartedAt: '2026-09-21T12:00:00.000Z',
    windowEndedAt: '2026-09-21T12:05:00.000Z',
  });

  async function ingest(input: ReturnType<typeof payload>) {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/log-anomalies',
      payload: input,
    });
    expect(response.statusCode).toBe(202);
    return LogAnomalyIngestionResultSchema.parse(response.json());
  }

  async function settled(id: string) {
    await expect
      .poll(
        async () => {
          const response = await api.inject({
            method: 'GET',
            url: `/api/v1/triage-cases/${id}`,
          });
          const detail = TriageCaseDetailSchema.parse(response.json());
          return detail.triageCase.status === 'queued' ? null : detail;
        },
        { timeout: 15_000, interval: 100 },
      )
      .not.toBeNull();
    const response = await api.inject({
      method: 'GET',
      url: `/api/v1/triage-cases/${id}`,
    });
    return TriageCaseDetailSchema.parse(response.json());
  }

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    healthSystem = createPostgresHealthSystem({
      connectionString: isolatedUrl.toString(),
      clock,
      queueName: `health-${randomUUID()}`,
    });
    triageSystem = createPostgresTriageSystem({
      connectionString: isolatedUrl.toString(),
      clock,
      queueName,
    });
    await healthSystem.start();
    await triageSystem.start();
    api = await buildApi({
      healthSystem,
      triageSystem,
      allowedOrigin: 'http://localhost:3000',
      operatorKey: 'test-operator-key',
      logger: false,
    });
    worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
    });
    await worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await triageSystem?.stop();
    await healthSystem?.stop();
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  it('validates required Log Anomaly facts at the public endpoint', async () => {
    const input = payload('checkout-api', 28, ['timeout', 'failure']);
    for (const field of [
      'service',
      'region',
      'errorSignature',
      'occurrenceCount',
      'sampleMessages',
      'windowStartedAt',
      'windowEndedAt',
    ]) {
      const invalid = { ...input, [field]: null };
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/log-anomalies',
        payload: invalid,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Invalid Log Anomaly');
    }
  });

  it('normalizes a repeated error and creates and assigns a P2 Incident without paging', async () => {
    const input = payload('checkout-api', 28, [
      'Authorization timed out',
      'Payment request failed',
    ]);
    const accepted = await ingest(input);
    expect(accepted.signal).toMatchObject({
      sourceType: 'log_anomaly',
      occurredAt: input.windowEndedAt,
      receivedAt: clock.now().toISOString(),
      title: input.errorSignature,
      service: input.service,
      region: input.region,
      facts: {
        errorSignature: input.errorSignature,
        occurrenceCount: 28,
        sampleMessages: input.sampleMessages,
        windowStartedAt: input.windowStartedAt,
        windowEndedAt: input.windowEndedAt,
      },
    });
    const detail = await settled(accepted.triageCase.id);
    expect(detail.triageCase.status).toBe('incident_created');
    expect(detail.evaluation?.judgments).toMatchObject({
      priorityAssessment: { choice: 'P2' },
      primaryOwningDomain: { choice: 'payments' },
      evidenceSufficiency: { yesProbability: 0.98 },
    });
    expect(detail.policyDecision?.authorizedActions).toEqual([
      'create_incident',
      'assign_owner',
    ]);
    expect(detail.workflowActions.map((action) => action.type)).toEqual([
      'create_incident',
      'assign_owner',
    ]);
    expect(
      detail.workflowActions.some((action) => action.type === 'page_on_call'),
    ).toBe(false);
    await expect
      .poll(
        async () => {
          const response = await api.inject({
            method: 'GET',
            url: `/api/v1/incidents/${detail.incidentId}`,
          });
          return IncidentDetailSchema.parse(response.json()).incident
            .primaryOwningDomain;
        },
        { timeout: 15_000, interval: 100 },
      )
      .toBe('payments');
    const incidentResponse = await api.inject({
      method: 'GET',
      url: `/api/v1/incidents/${detail.incidentId}`,
    });
    const incident = IncidentDetailSchema.parse(incidentResponse.json());
    expect(incident.incident).toMatchObject({
      currentPriority: 'P2',
      primaryOwningDomain: 'payments',
    });
    expect(incident.signal).toEqual(accepted.signal);
    expect(incident.evaluation.judgments?.priorityAssessment.choice).toBe('P2');
    const replay = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/log-anomalies',
      payload: input,
    });
    expect(replay.statusCode).toBe(200);
    expect(LogAnomalyIngestionResultSchema.parse(replay.json())).toMatchObject({
      deduplicated: true,
      triageCase: { id: accepted.triageCase.id },
    });
  });

  it('keeps a low-evidence P3 Signal in review until an Operator dismisses it', async () => {
    const accepted = await ingest(
      payload('checkout-api', 1, ['Single transient timeout']),
    );
    const detail = await settled(accepted.triageCase.id);
    expect(detail.triageCase.status).toBe('needs_review');
    expect(detail.evaluation?.judgments).toMatchObject({
      priorityAssessment: { choice: 'P3' },
      evidenceSufficiency: { yesProbability: 0.4 },
    });
    expect(detail.reviewTask?.reason).toContain('Evidence Sufficiency');
    expect(detail.incidentId).toBeNull();
    expect(detail.workflowActions).toEqual([]);
    const dismissal = await api.inject({
      method: 'POST',
      url: `/api/v1/review-tasks/${detail.triageCase.id}/resolve`,
      headers: { 'x-operator-key': 'test-operator-key' },
      payload: {
        actor: 'demo-operator',
        reason: 'One transient occurrence.',
        resolution: { type: 'dismiss' },
      },
    });
    expect(dismissal.statusCode).toBe(200);
    expect(dismissal.json()).toMatchObject({
      triageCase: { status: 'dismissed' },
      humanOverrides: [
        {
          reason: 'One transient occurrence.',
          replacementOutcome: { type: 'dismiss' },
        },
      ],
    });
  });

  it('reviews a well-documented P3 Signal without creating an Incident or page', async () => {
    const accepted = await ingest(
      payload('checkout-api', 1, ['Transient timeout', 'Recovered on retry']),
    );
    const detail = await settled(accepted.triageCase.id);
    expect(detail.evaluation?.judgments).toMatchObject({
      priorityAssessment: { choice: 'P3' },
      evidenceSufficiency: { yesProbability: 0.98 },
    });
    expect(detail.triageCase.status).toBe('needs_review');
    expect(detail.reviewTask?.reason).toContain('Incident creation policy');
    expect(detail.policyDecision?.authorizedActions).toEqual([]);
    expect(detail.incidentId).toBeNull();
    expect(detail.workflowActions).toEqual([]);
  });

  it('keeps unknown ownership explicit and creates a Review Task without assignment', async () => {
    const accepted = await ingest(
      payload('unmapped-service', 28, ['timeout', 'failure']),
    );
    const detail = await settled(accepted.triageCase.id);
    expect(detail.evaluation?.judgments?.primaryOwningDomain.choice).toBe(
      'unknown',
    );
    expect(detail.reviewTask?.reason).toContain(
      'Primary Owning Domain is unknown',
    );
    expect(detail.policyDecision?.authorizedActions).toEqual([
      'create_incident',
    ]);
    expect(detail.workflowActions.map((action) => action.type)).toEqual([
      'create_incident',
    ]);
    const incident = IncidentDetailSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/v1/incidents/${detail.incidentId}`,
        })
      ).json(),
    );
    expect(incident.incident.primaryOwningDomain).toBe('unknown');
  });
});
