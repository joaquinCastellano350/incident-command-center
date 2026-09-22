import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { buildApi } from '../../apps/api/src/app.js';
import {
  JevOperationalJudgmentProvider,
  RecordedJevTransport,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import {
  DeploymentEventIngestionResultSchema,
  MonitoringAlertIngestionResultSchema,
  TriageCaseDetailSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const expectedSignal = {
  service: `checkout-jev-${randomUUID()}`,
  region: 'us-east',
  metric: 'payment_authorization_failure_rate',
  threshold: 2,
  observedValue: 18,
};

describeWithPostgres(
  'audited Jev Evaluation at the ingestion-to-query seam',
  () => {
    const clock = new ManualClock('2026-09-21T12:04:00.000Z');
    const queueName = `jev-evaluation-${randomUUID()}`;
    const databaseName = `incident_test_${randomUUID().replaceAll('-', '_')}`;
    const adminUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
    adminUrl.pathname = '/postgres';
    const isolatedUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
    isolatedUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminUrl.toString() });
    let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
    let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
    let api: Awaited<ReturnType<typeof buildApi>>;

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
        logger: false,
      });
    });

    afterAll(async () => {
      await api?.close();
      await triageSystem?.stop();
      await healthSystem?.stop();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end();
    });

    beforeEach(async () => {
      const pool = new Pool({ connectionString: isolatedUrl.toString() });
      try {
        await pool.query('TRUNCATE signals CASCADE');
      } finally {
        await pool.end();
      }
    });

    async function submitAlert(signalFacts = expectedSignal) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/monitoring-alerts',
        payload: {
          provider: 'northstar-monitoring',
          sourceEventKey: randomUUID(),
          sourceReference: 'mon-checkout-authorization-failures',
          ...signalFacts,
          occurredAt: '2026-09-21T12:04:00.000Z',
          evaluationWindowSeconds: 600,
        },
      });
      expect(response.statusCode).toBe(202);
      return MonitoringAlertIngestionResultSchema.parse(response.json());
    }

    async function detail(id: string) {
      const response = await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${id}`,
      });
      expect(response.statusCode).toBe(200);
      return TriageCaseDetailSchema.parse(response.json());
    }

    it('persists a recorded typed response with its probabilities and audit metadata', async () => {
      const recording = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      const accepted = await submitAlert();
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            body: recording[0].body,
            requestId: 'recorded:canonical-p1-v1',
            expectedCorroboratingKinds: ['threshold_breach'],
            expectedSignal: {
              sourceType: 'monitoring_alert',
              service: expectedSignal.service,
              region: expectedSignal.region,
              facts: {
                metric: expectedSignal.metric,
                threshold: expectedSignal.threshold,
                observedValue: expectedSignal.observedValue,
              },
            },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          configuredModel: 'jev-1.13.0',
          resolvedModel: 'jev-1.13.0',
          providerRequestId: 'recorded:canonical-p1-v1',
          inputTokens: 512,
          outputTokens: 96,
          retryCount: 0,
          decisionSchemaVersion: 'operational-judgments.v1',
          questionSetVersion: 'northstar-triage.v1',
          judgments: {
            priorityAssessment: { choice: 'P1' },
            evidenceSufficiency: { yesProbability: 0.99 },
          },
        });
        expect(
          result.evaluation?.judgments?.primaryOwningDomain.probabilities,
        ).toHaveLength(5);
        expect(result.evaluation?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.incidentId).not.toBeNull();
      } finally {
        await worker.stop();
      }
    });

    it('records invalid responses as failed Evaluations and creates a Review Task', async () => {
      const invalidSignal = {
        ...expectedSignal,
        service: `invalid-jev-${randomUUID()}`,
      };
      const accepted = await submitAlert(invalidSignal);
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            body: {
              model: 'jev-1.13.0',
              answers: {},
              usage: { input_tokens: 12, output_tokens: 2 },
            },
            requestId: 'recorded:invalid',
            expectedCorroboratingKinds: ['threshold_breach'],
            expectedSignal: {
              sourceType: 'monitoring_alert',
              service: invalidSignal.service,
              region: invalidSignal.region,
              facts: {
                metric: invalidSignal.metric,
                threshold: invalidSignal.threshold,
                observedValue: invalidSignal.observedValue,
              },
            },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('failed');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          status: 'failed',
          providerRequestId: 'recorded:invalid',
          inputTokens: 12,
          outputTokens: 2,
          failure: { kind: 'invalid_response' },
          judgments: null,
          incidentMatches: [],
        });
        expect(result.triageCase.status).toBe('needs_review');
        expect(result.reviewTask).toMatchObject({ urgency: 'urgent' });
        expect(result.policyDecision).toBeNull();
        expect(result.workflowActions).toEqual([]);
      } finally {
        await worker.stop();
      }
    });

    it('evaluates a Deployment Event without creating an Incident', async () => {
      const service = `deployment-jev-${randomUUID()}`;
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/deployment-events',
        payload: {
          provider: 'northstar-deployments',
          sourceEventKey: randomUUID(),
          sourceReference: 'deploy-checkout-2026-09-20-3',
          service,
          region: 'us-east',
          version: '2026.09.20.3',
          commitReference: 'a91ce0f',
          deployer: 'release-bot',
          outcome: 'succeeded',
          occurredAt: '2026-09-21T12:00:00.000Z',
        },
      });
      const accepted = DeploymentEventIngestionResultSchema.parse(
        response.json(),
      );
      const recordings = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      const deployment = recordings[1];
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            ...deployment,
            expectedSignal: { ...deployment.expectedSignal, service },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          judgments: { priorityAssessment: { choice: 'P3' } },
        });
        expect(result.incidentId).toBeNull();
        expect(result.workflowActions).toEqual([]);
        expect(result.reviewTask).toMatchObject({ urgency: 'standard' });
      } finally {
        await worker.stop();
      }
    });
  },
);
