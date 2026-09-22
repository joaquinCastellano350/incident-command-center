import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { buildApi } from '../apps/api/src/app.js';
import {
  TRIAGE_QUEUE,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import {
  MonitoringAlertIngestionResultSchema,
  TriageCaseDetailSchema,
  type PageRequest,
} from '@incident-command-center/contracts';
import type { PagingProviderPort } from '@incident-command-center/domain';
import { ManualClock } from '@incident-command-center/testing';

const baseUrl = new URL(
  process.env.DATABASE_URL ??
    'postgres://incident:incident@localhost:5432/incident_command_center',
);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const databaseName = `incident_drill_${randomUUID().replaceAll('-', '_')}`;
const drillUrl = new URL(baseUrl);
drillUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: adminUrl.toString() });
const clock = new ManualClock('2026-09-22T12:00:00.000Z');
const queueName = `${TRIAGE_QUEUE}-${randomUUID()}`;
const effects = new Map<string, string>();
let crashPending = true;
const pagingProvider: PagingProviderPort<PageRequest> = {
  async page(request) {
    const reference = effects.get(request.idempotencyKey) ?? randomUUID();
    effects.set(request.idempotencyKey, reference);
    return { providerReference: reference };
  },
};

let healthSystem: ReturnType<typeof createPostgresHealthSystem> | undefined;
let triageSystem: ReturnType<typeof createPostgresTriageSystem> | undefined;
let worker: ReturnType<typeof createPostgresTriageWorker> | undefined;
let api: Awaited<ReturnType<typeof buildApi>> | undefined;

async function detail(id: string) {
  const response = await api!.inject({
    method: 'GET',
    url: `/api/v1/triage-cases/${id}`,
  });
  if (response.statusCode !== 200) throw new Error(response.body);
  return TriageCaseDetailSchema.parse(response.json());
}

async function waitForPage(
  id: string,
  predicate: (status: string, suppressed: number) => boolean,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await detail(id);
    const page = result.workflowActions.find(
      (action) => action.type === 'page_on_call',
    );
    if (page && predicate(page.status, page.suppressedCount)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Workflow Action did not reach the expected state');
}

try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  healthSystem = createPostgresHealthSystem({
    connectionString: drillUrl.toString(),
    clock,
    queueName: `health-${randomUUID()}`,
  });
  await healthSystem.start();
  triageSystem = createPostgresTriageSystem({
    connectionString: drillUrl.toString(),
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
  worker = createPostgresTriageWorker({
    connectionString: drillUrl.toString(),
    queueName,
    clock,
    pagingProvider,
    claimLeaseMs: 1000,
    afterProviderEffect: async (action) => {
      if (action.type === 'page_on_call' && crashPending) {
        crashPending = false;
        throw new Error('Trust drill: worker stopped after provider effect');
      }
    },
  });
  await worker.start();

  const payload = {
    provider: 'northstar-monitoring',
    sourceEventKey: `trust-drill-${randomUUID()}`,
    sourceReference: 'trust-drill-checkout-failures',
    metric: 'payment_authorization_failure_rate',
    threshold: 2,
    observedValue: 18,
    service: 'checkout-api',
    region: 'us-east',
    occurredAt: clock.now().toISOString(),
    evaluationWindowSeconds: 600,
  };
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/signals/monitoring-alerts',
    payload,
  });
  if (response.statusCode !== 202) throw new Error(response.body);
  const accepted = MonitoringAlertIngestionResultSchema.parse(response.json());
  const completed = await waitForPage(
    accepted.triageCase.id,
    (status) => status === 'succeeded',
  );
  const page = completed.workflowActions.find(
    (action) => action.type === 'page_on_call',
  )!;

  await Promise.all([
    triageSystem.replayWorkflowAction(page.id),
    triageSystem.replayWorkflowAction(page.id),
    api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload,
    }),
  ]);
  const replayed = await waitForPage(
    accepted.triageCase.id,
    (status, suppressed) => status === 'succeeded' && suppressed >= 2,
  );
  console.log(
    JSON.stringify(
      {
        signalId: accepted.signal.id,
        triageCaseId: accepted.triageCase.id,
        incidentId: replayed.incidentId,
        page: replayed.workflowActions.find(
          (action) => action.type === 'page_on_call',
        ),
        observablePageCount: effects.size,
      },
      null,
      2,
    ),
  );
} finally {
  await api?.close();
  await worker?.stop();
  await triageSystem?.stop();
  await healthSystem?.stop();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
}
