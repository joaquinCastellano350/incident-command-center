import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  TRIAGE_QUEUE,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import {
  IncidentDetailSchema,
  MonitoringAlertIngestionResultSchema,
  TriageCaseDetailSchema,
  type AssignmentRequest,
  type PageRequest,
} from '@incident-command-center/contracts';
import {
  WorkflowProviderError,
  type AssignmentProviderPort,
  type PagingProviderPort,
} from '@incident-command-center/domain';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

class ReplaySafePagingProvider implements PagingProviderPort<PageRequest> {
  readonly effects = new Map<string, string>();
  readonly calls: PageRequest[] = [];
  failAfterEffect = false;
  failPermanently = false;

  async page(request: PageRequest): Promise<{ providerReference: string }> {
    this.calls.push(request);
    if (this.failPermanently)
      throw new WorkflowProviderError(
        'Paging provider rejected request',
        false,
      );
    const reference = this.effects.get(request.idempotencyKey) ?? randomUUID();
    this.effects.set(request.idempotencyKey, reference);
    if (this.failAfterEffect) {
      this.failAfterEffect = false;
      throw new WorkflowProviderError('Reply lost after provider effect', true);
    }
    return { providerReference: reference };
  }
}

class FailingAssignmentProvider implements AssignmentProviderPort<AssignmentRequest> {
  async assign(): Promise<{ providerReference: string }> {
    throw new WorkflowProviderError(
      'Assignment provider rejected request',
      false,
    );
  }
}

describe.skipIf(!databaseUrl)('Workflow Action reliability', () => {
  const clock = new ManualClock('2026-09-22T12:00:00.000Z');
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

  beforeEach(async () => {
    const pool = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      await pool.query('TRUNCATE signals CASCADE');
    } finally {
      await pool.end();
    }
  });

  async function ingestAlert() {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: `reliability-${randomUUID()}`,
        sourceReference: 'mon-checkout-reliability',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: clock.now().toISOString(),
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
    return TriageCaseDetailSchema.parse(response.json());
  }

  it('retries a lost provider reply with one observable page and an attempt history', async () => {
    const alert = await ingestAlert();
    const pagingProvider = new ReplaySafePagingProvider();
    pagingProvider.failAfterEffect = true;
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
            const page = (
              await detail(alert.triageCase.id)
            ).workflowActions.find((action) => action.type === 'page_on_call');
            return page?.status;
          },
          { timeout: 20_000, interval: 100 },
        )
        .toBe('succeeded');
      const result = await detail(alert.triageCase.id);
      const page = result.workflowActions.find(
        (action) => action.type === 'page_on_call',
      )!;
      expect(result.incidentId).not.toBeNull();
      expect(pagingProvider.effects.size).toBe(1);
      expect(pagingProvider.calls).toHaveLength(2);
      expect(pagingProvider.calls[0]?.idempotencyKey).toBe(
        pagingProvider.calls[1]?.idempotencyKey,
      );
      expect(page.idempotencyKey).toContain(result.policyDecision!.id);
      expect(page.attempts.map((attempt) => attempt.outcome)).toEqual([
        'started',
        'transient_failure',
        'started',
        'succeeded',
      ]);
      expect(page.suppressedCount).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it('recovers a worker crash after the provider effect without a second page', async () => {
    const alert = await ingestAlert();
    const pagingProvider = new ReplaySafePagingProvider();
    let crashPending = true;
    const worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      pagingProvider,
      claimLeaseMs: 1000,
      afterProviderEffect: async (action) => {
        if (action.type === 'page_on_call' && crashPending) {
          crashPending = false;
          throw new Error('Simulated worker crash after provider effect');
        }
      },
    });
    await worker.start();
    try {
      await expect
        .poll(
          async () =>
            (await detail(alert.triageCase.id)).workflowActions.find(
              (action) => action.type === 'page_on_call',
            )?.status,
          { timeout: 20_000, interval: 100 },
        )
        .toBe('succeeded');
      const page = (await detail(alert.triageCase.id)).workflowActions.find(
        (action) => action.type === 'page_on_call',
      )!;
      expect(pagingProvider.effects.size).toBe(1);
      expect(pagingProvider.calls).toHaveLength(2);
      expect(page.attempts.map((attempt) => attempt.outcome)).toEqual([
        'started',
        'interrupted',
        'started',
        'succeeded',
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('keeps the Incident and creates urgent review when paging fails permanently', async () => {
    const alert = await ingestAlert();
    const pagingProvider = new ReplaySafePagingProvider();
    pagingProvider.failPermanently = true;
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
            const page = (
              await detail(alert.triageCase.id)
            ).workflowActions.find((action) => action.type === 'page_on_call');
            return page?.status;
          },
          { timeout: 20_000, interval: 100 },
        )
        .toBe('permanently_failed');
      const result = await detail(alert.triageCase.id);
      expect(result.incidentId).not.toBeNull();
      expect(result.triageCase.status).toBe('needs_review');
      expect(result.reviewTask).toMatchObject({ urgency: 'urgent' });
      expect(
        result.workflowActions.find(
          (action) => action.type === 'create_incident',
        )?.status,
      ).toBe('succeeded');
      expect(
        result.workflowActions
          .find((action) => action.type === 'page_on_call')
          ?.attempts.at(-1)?.outcome,
      ).toBe('permanent_failure');
      const incidentResponse = await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${result.incidentId}`,
      });
      const incident = IncidentDetailSchema.parse(incidentResponse.json());
      expect(incident.reviewTask?.urgency).toBe('urgent');
      expect(
        incident.workflowActions.find(
          (action) => action.type === 'page_on_call',
        )?.status,
      ).toBe('permanently_failed');
    } finally {
      await worker.stop();
    }
  });

  it('stops transient paging failures after three attempts', async () => {
    const alert = await ingestAlert();
    const pagingProvider = new ReplaySafePagingProvider();
    pagingProvider.page = async (request) => {
      pagingProvider.calls.push(request);
      throw new WorkflowProviderError('Paging provider unavailable', true);
    };
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
          async () =>
            (await detail(alert.triageCase.id)).workflowActions.find(
              (action) => action.type === 'page_on_call',
            )?.status,
          { timeout: 20_000, interval: 100 },
        )
        .toBe('permanently_failed');
      const result = await detail(alert.triageCase.id);
      const page = result.workflowActions.find(
        (action) => action.type === 'page_on_call',
      )!;
      expect(pagingProvider.calls).toHaveLength(3);
      expect(page.attempts.map((attempt) => attempt.outcome)).toEqual([
        'started',
        'transient_failure',
        'started',
        'transient_failure',
        'started',
        'permanent_failure',
      ]);
      expect(page.nextRetryAt).toBeNull();
      expect(result.reviewTask?.urgency).toBe('urgent');
      expect(result.incidentId).not.toBeNull();
    } finally {
      await worker.stop();
    }
  });

  it('keeps the open Incident and suppresses paging after assignment failure', async () => {
    const alert = await ingestAlert();
    const pagingProvider = new ReplaySafePagingProvider();
    const worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      pagingProvider,
      assignmentProvider: new FailingAssignmentProvider(),
    });
    await worker.start();
    try {
      await expect
        .poll(
          async () =>
            (await detail(alert.triageCase.id)).workflowActions.find(
              (action) => action.type === 'assign_owner',
            )?.status,
          { timeout: 20_000, interval: 100 },
        )
        .toBe('permanently_failed');
      const result = await detail(alert.triageCase.id);
      expect(result.incidentId).not.toBeNull();
      expect(result.reviewTask).toMatchObject({ urgency: 'urgent' });
      expect(result.workflowActions.map((action) => action.status)).toEqual([
        'succeeded',
        'permanently_failed',
        'permanently_failed',
      ]);
      expect(result.workflowActions[2]?.attempts[0]?.outcome).toBe(
        'suppressed',
      );
      expect(pagingProvider.effects.size).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it('lets competing workers claim a page once and records duplicate suppression', async () => {
    const alert = await ingestAlert();
    let enterPage!: () => void;
    let releasePage!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterPage = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    class BlockingPagingProvider extends ReplaySafePagingProvider {
      override async page(request: PageRequest) {
        enterPage();
        await gate;
        return super.page(request);
      }
    }
    const pagingProvider = new BlockingPagingProvider();
    const workers = [0, 1].map(() =>
      createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        pagingProvider,
      }),
    );
    await Promise.all(workers.map((worker) => worker.start()));
    try {
      await entered;
      const page = (await detail(alert.triageCase.id)).workflowActions.find(
        (action) => action.type === 'page_on_call',
      )!;
      await Promise.all([
        triageSystem.replayWorkflowAction(page.id),
        triageSystem.replayWorkflowAction(page.id),
      ]);
      await expect
        .poll(
          async () =>
            (await detail(alert.triageCase.id)).workflowActions.find(
              (action) => action.id === page.id,
            )?.suppressedCount,
          { timeout: 15_000, interval: 100 },
        )
        .toBeGreaterThanOrEqual(1);
      releasePage();
      await expect
        .poll(
          async () =>
            (await detail(alert.triageCase.id)).workflowActions.find(
              (action) => action.id === page.id,
            )?.status,
          { timeout: 15_000, interval: 100 },
        )
        .toBe('succeeded');
      const finished = (await detail(alert.triageCase.id)).workflowActions.find(
        (action) => action.id === page.id,
      )!;
      expect(
        finished.attempts.some((attempt) => attempt.outcome === 'suppressed'),
      ).toBe(true);
      expect(pagingProvider.effects.size).toBe(1);
      expect(pagingProvider.calls).toHaveLength(1);
    } finally {
      releasePage();
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  });
});
