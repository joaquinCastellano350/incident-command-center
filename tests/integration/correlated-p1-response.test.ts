import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  TRIAGE_QUEUE,
  createPostgresHealthSystem,
  createPostgresTriageWorker,
  createPostgresTriageSystem,
} from '@incident-command-center/adapters';
import {
  DeploymentEventIngestionResultSchema,
  IncidentDetailSchema,
  MonitoringAlertIngestionResultSchema,
  PageRequestSchema,
  TriageCaseDetailSchema,
  type AssignmentRequest,
  type PageRequest,
} from '@incident-command-center/contracts';
import type {
  AssignmentProviderPort,
  PagingProviderPort,
} from '@incident-command-center/domain';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

class RecordingPagingProvider implements PagingProviderPort<PageRequest> {
  readonly calls: PageRequest[] = [];

  async page(page: PageRequest): Promise<{ providerReference: string }> {
    this.calls.push(PageRequestSchema.parse(page));
    return { providerReference: `page-${this.calls.length}` };
  }
}

class RecordingAssignmentProvider implements AssignmentProviderPort<AssignmentRequest> {
  readonly calls: AssignmentRequest[] = [];

  async assign(
    assignment: AssignmentRequest,
  ): Promise<{ providerReference: string }> {
    this.calls.push(assignment);
    return { providerReference: `assignment-${this.calls.length}` };
  }
}

describeWithPostgres('canonical correlated P1 response', () => {
  const clock = new ManualClock('2026-09-21T12:00:00.000Z');
  const queueName = `${TRIAGE_QUEUE}-${randomUUID()}`;
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
    await healthSystem.start();
    triageSystem = createPostgresTriageSystem({
      connectionString: isolatedUrl.toString(),
      clock,
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
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  it('accepts and normalizes the checkout Deployment Event', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/deployment-events',
      payload: {
        provider: 'northstar-deployments',
        sourceEventKey: `deploy-checkout-${randomUUID()}`,
        sourceReference: 'deploy-checkout-2026-09-20-3',
        service: 'checkout-api',
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

    expect(response.statusCode).toBe(202);
    expect(accepted).toMatchObject({
      deduplicated: false,
      signal: {
        sourceType: 'deployment_event',
        sourceReference: 'deploy-checkout-2026-09-20-3',
        occurredAt: '2026-09-21T12:00:00.000Z',
        receivedAt: '2026-09-21T12:00:00.000Z',
        service: 'checkout-api',
        region: 'us-east',
        facts: {
          version: '2026.09.20.3',
          commitReference: 'a91ce0f',
          deployer: 'release-bot',
          outcome: 'succeeded',
        },
      },
      triageCase: {
        status: 'queued',
        sourceReference: 'deploy-checkout-2026-09-20-3',
      },
    });

    const detailResponse = await api.inject({
      method: 'GET',
      url: `/api/v1/triage-cases/${accepted.triageCase.id}`,
    });
    const detail = TriageCaseDetailSchema.parse(detailResponse.json());

    expect(detailResponse.statusCode).toBe(200);
    expect(detail.signal).toEqual(accepted.signal);
  });

  it('creates, assigns, and pages one P1 Incident for the correlated alert', async () => {
    clock.set('2026-09-21T12:04:00.000Z');
    const alertPayload = {
      provider: 'northstar-monitoring',
      sourceEventKey: `alert-checkout-${randomUUID()}`,
      sourceReference: 'mon-checkout-authorization-failures',
      metric: 'payment_authorization_failure_rate',
      threshold: 2,
      observedValue: 18,
      service: 'checkout-api',
      region: 'us-east',
      occurredAt: '2026-09-21T12:04:00.000Z',
      evaluationWindowSeconds: 600,
    };
    const alertResponse = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: alertPayload,
    });
    const alert = MonitoringAlertIngestionResultSchema.parse(
      alertResponse.json(),
    );
    const pagingProvider = new RecordingPagingProvider();
    const assignmentProvider = new RecordingAssignmentProvider();
    const worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      pagingProvider,
      assignmentProvider,
    });

    await worker.start();
    try {
      await expect
        .poll(
          async () => {
            const response = await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${alert.triageCase.id}`,
            });
            if (response.statusCode !== 200) return null;
            return TriageCaseDetailSchema.parse(response.json());
          },
          { timeout: 15_000, interval: 100 },
        )
        .toMatchObject({
          triageCase: { status: 'incident_created' },
          workflowActions: [
            { status: 'succeeded' },
            { status: 'succeeded' },
            { status: 'succeeded' },
          ],
        });

      const detailResponse = await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${alert.triageCase.id}`,
      });
      const triageDetail = TriageCaseDetailSchema.parse(detailResponse.json());

      expect(triageDetail.evaluation).toMatchObject({
        status: 'succeeded',
        configuredModel: 'deterministic-canonical-v1',
        resolvedModel: 'deterministic-canonical-v1',
        questionSetVersion: 'northstar-triage.v1',
        judgments: {
          priorityAssessment: { choice: 'P1' },
          customerReach: { choice: 'widespread' },
          regionalReach: { choice: 'single_region' },
          serviceBreadth: { choice: 'single_service' },
          primaryOwningDomain: { choice: 'payments' },
          evidenceSufficiency: { yesProbability: 0.99 },
        },
      });
      expect(triageDetail.corroboratingFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'threshold_breach' }),
          expect.objectContaining({
            kind: 'recent_deployment',
            evidenceSignalIds: [expect.any(String)],
          }),
        ]),
      );
      expect(triageDetail.policyDecision).toMatchObject({
        version: 'northstar-automation.v1',
        thresholds: {
          priorityChoiceProbability: 0.95,
          impactChoiceProbability: 0.95,
          ownershipChoiceProbability: 0.95,
          evidenceSufficiencyYesProbability: 0.95,
        },
        authorizedActions: ['create_incident', 'assign_owner', 'page_on_call'],
      });
      expect(triageDetail.incidentId).toEqual(expect.any(String));
      expect(triageDetail.evaluation?.correlationId).toBe(
        alert.signal.correlationId,
      );
      expect(triageDetail.policyDecision?.correlationId).toBe(
        alert.signal.correlationId,
      );
      expect(
        triageDetail.workflowActions.every(
          (action) => action.correlationId === alert.signal.correlationId,
        ),
      ).toBe(true);
      expect(
        triageDetail.timelineEvents.every(
          (event) => event.correlationId === alert.signal.correlationId,
        ),
      ).toBe(true);

      const incidentResponse = await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${triageDetail.incidentId}`,
      });
      const incidentDetail = IncidentDetailSchema.parse(
        incidentResponse.json(),
      );

      expect(incidentResponse.statusCode).toBe(200);
      expect(incidentDetail.incident).toMatchObject({
        status: 'open',
        currentPriority: 'P1',
        primaryOwningDomain: 'payments',
      });
      expect(incidentDetail.timelineEvents.map((event) => event.type)).toEqual([
        'incident_created',
        'owner_assigned',
        'on_call_paged',
      ]);
      expect(incidentDetail.workflowActions).toHaveLength(3);
      expect(pagingProvider.calls).toHaveLength(1);
      expect(assignmentProvider.calls).toHaveLength(1);
      expect(assignmentProvider.calls[0]?.idempotencyKey).toBe(
        triageDetail.workflowActions.find(
          (action) => action.type === 'assign_owner',
        )?.idempotencyKey,
      );
      expect(pagingProvider.calls[0]).toMatchObject({
        incidentId: incidentDetail.incident.id,
        priority: 'P1',
        owningDomain: 'payments',
        idempotencyKey: `workflow:northstar-automation.v1:${triageDetail.policyDecision!.id}:page_on_call`,
      });
      expect(
        incidentDetail.workflowActions.find(
          (action) => action.type === 'page_on_call',
        )?.idempotencyKey,
      ).toBe(pagingProvider.calls[0]?.idempotencyKey);

      const replayResponse = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/monitoring-alerts',
        payload: alertPayload,
      });
      const replay = MonitoringAlertIngestionResultSchema.parse(
        replayResponse.json(),
      );
      expect(replayResponse.statusCode).toBe(200);
      expect(replay.deduplicated).toBe(true);
      expect(replay.triageCase.id).toBe(alert.triageCase.id);
      expect(pagingProvider.calls).toHaveLength(1);
      expect(assignmentProvider.calls).toHaveLength(1);
      const afterReplay = TriageCaseDetailSchema.parse(
        (
          await api.inject({
            method: 'GET',
            url: `/api/v1/triage-cases/${alert.triageCase.id}`,
          })
        ).json(),
      );
      expect(afterReplay.workflowActions.map((action) => action.id)).toEqual(
        triageDetail.workflowActions.map((action) => action.id),
      );
    } finally {
      await worker.stop();
    }
  });

  it('does not page a high-confidence P1 assessment without a Corroborating Fact', async () => {
    const pool = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      await pool.query('TRUNCATE signals CASCADE');
    } finally {
      await pool.end();
    }
    clock.set('2026-09-21T12:08:00.000Z');
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: `uncorroborated-checkout-${randomUUID()}`,
        sourceReference: 'mon-uncorroborated-checkout',
        metric: 'payment_authorization_failure_rate',
        threshold: 20,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: '2026-09-21T12:08:00.000Z',
        evaluationWindowSeconds: 600,
      },
    });
    const alert = MonitoringAlertIngestionResultSchema.parse(response.json());
    const pagingProvider = new RecordingPagingProvider();
    const worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      pagingProvider,
    });

    await worker.start();
    try {
      await expect
        .poll(
          async () => {
            const detailResponse = await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${alert.triageCase.id}`,
            });
            return TriageCaseDetailSchema.parse(detailResponse.json());
          },
          { timeout: 15_000, interval: 100 },
        )
        .toMatchObject({
          triageCase: { status: 'incident_created' },
          workflowActions: [{ status: 'succeeded' }, { status: 'succeeded' }],
        });

      const detail = TriageCaseDetailSchema.parse(
        (
          await api.inject({
            method: 'GET',
            url: `/api/v1/triage-cases/${alert.triageCase.id}`,
          })
        ).json(),
      );

      expect(detail.evaluation?.judgments.priorityAssessment.choice).toBe('P1');
      expect(detail.corroboratingFacts).toEqual([]);
      expect(detail.policyDecision?.authorizedActions).toEqual([
        'create_incident',
        'assign_owner',
      ]);
      expect(
        detail.policyDecision?.rules.find(
          (rule) => rule.action === 'page_on_call',
        ),
      ).toMatchObject({ outcome: 'denied' });
      expect(detail.workflowActions.map((action) => action.type)).toEqual([
        'create_incident',
        'assign_owner',
      ]);
      expect(pagingProvider.calls).toEqual([]);
    } finally {
      await worker.stop();
    }
  });
});
