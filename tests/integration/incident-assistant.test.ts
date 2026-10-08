import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  createPostgresAssistantSystem,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
  DeterministicOperationalJudgmentProvider,
} from '@incident-command-center/adapters';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('Incident assistant at the API seam', () => {
  const clock = new ManualClock('2026-09-21T12:04:00.000Z');
  const databaseName = `incident_test_${randomUUID().replaceAll('-', '_')}`;
  const adminUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  adminUrl.pathname = '/postgres';
  const isolatedUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const calls: unknown[] = [];
  let response: unknown;
  let api: Awaited<ReturnType<typeof buildApi>>;
  let incidentId: string;
  let signalId: string;
  let timelineEventId: string;
  let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
  let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
  let assistantSystem: ReturnType<typeof createPostgresAssistantSystem>;
  let worker: ReturnType<typeof createPostgresTriageWorker>;

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
      queueName: `triage-${randomUUID()}`,
    });
    assistantSystem = createPostgresAssistantSystem({
      connectionString: isolatedUrl.toString(),
      clock,
      provider: {
        async generate(request: unknown) {
          calls.push(request);
          return response;
        },
      },
      mode: 'recorded',
      configuredModel: 'gpt-5.6-terra-recorded-v1',
    });
    await healthSystem.start();
    await triageSystem.start();
    await assistantSystem.start();
    api = await buildApi({
      healthSystem,
      triageSystem,
      assistantSystem,
      allowedOrigin: 'http://localhost:3000',
      operatorKey: 'test-operator-key',
      logger: false,
    });
    worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName: triageSystem.queue.name,
      clock,
      judgmentProvider: new DeterministicOperationalJudgmentProvider(),
    });
    await worker.start();
    const ingestion = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: randomUUID(),
        sourceReference: 'assistant-alert',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: clock.now().toISOString(),
        evaluationWindowSeconds: 600,
      },
    });
    const caseId = ingestion.json().triageCase.id as string;
    signalId = ingestion.json().signal.id as string;
    for (let attempt = 0; attempt < 100; attempt++) {
      incidentId = (
        await api.inject({
          method: 'GET',
          url: `/api/v1/triage-cases/${caseId}`,
        })
      ).json().incidentId;
      if (incidentId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!incidentId) throw new Error('Incident was not created');
    timelineEventId = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json().timelineEvents[0].id;
  });

  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await assistantSystem?.stop();
    await triageSystem?.stop();
    await healthSystem?.stop();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  const key = { 'x-operator-key': 'test-operator-key' };

  it('shows cited claims and distinct hypotheses while retaining the provider trace', async () => {
    response = {
      output: {
        claims: [
          {
            text: 'Checkout failure rate exceeded its threshold.',
            citations: [
              { type: 'signal', id: signalId },
              { type: 'timeline_event', id: timelineEventId },
            ],
          },
        ],
        hypotheses: ['A deployment may be related.'],
        draft: null,
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-1',
      latencyMs: 12,
    };
    const generated = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      headers: key,
      payload: { kind: 'summary', actor: 'demo-operator' },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().output.claims[0].citations).toEqual([
      { type: 'signal', id: signalId },
      { type: 'timeline_event', id: timelineEventId },
    ]);
    expect(generated.json().output.hypotheses).toEqual([
      'A deployment may be related.',
    ]);
    expect(generated.json()).toMatchObject({
      mode: 'recorded',
      configuredModel: 'gpt-5.6-terra-recorded-v1',
      returnedModel: 'gpt-5.6-terra-snapshot',
      outcome: 'accepted',
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('workflowActions');
    expect(JSON.stringify(calls[0])).not.toContain('sourceReference');
    const detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(detail.assistantInteractions).toHaveLength(1);
    expect(detail.assistantInteractions[0].inputEvidenceReferences).toEqual(
      expect.arrayContaining([
        { type: 'signal', id: signalId },
        { type: 'timeline_event', id: timelineEventId },
        { type: 'evaluation', id: detail.evaluation.id },
        { type: 'policy_decision', id: detail.policyDecision.id },
      ]),
    );
    expect(
      detail.timelineEvents.some(
        (event: { id: string }) => event.id === generated.json().id,
      ),
    ).toBe(false);
  });

  it('rejects nonexistent citations after a bounded retry and records both attempts', async () => {
    const before = calls.length;
    response = {
      output: {
        claims: [
          {
            text: 'Unsupported claim',
            citations: [{ type: 'signal', id: randomUUID() }],
          },
        ],
        hypotheses: [],
        draft: null,
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-invalid',
      latencyMs: 8,
    };
    const generated = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      headers: key,
      payload: {
        kind: 'question',
        actor: 'demo-operator',
        question: 'What happened?',
      },
    });
    expect(generated.statusCode).toBe(422);
    expect(calls).toHaveLength(before + 2);
    const detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(
      detail.assistantInteractions.filter(
        (item: { outcome: string }) => item.outcome === 'invalid_citation',
      ),
    ).toHaveLength(2);
    expect(
      detail.assistantInteractions
        .filter(
          (item: { outcome: string }) => item.outcome === 'invalid_citation',
        )
        .every((item: { output: unknown }) => item.output === null),
    ).toBe(true);
    expect(detail.publishedUpdates).toEqual([]);
    const audit = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      const rejected = await audit.query<{
        provider_output: { claims: unknown[] };
      }>(
        "SELECT provider_output FROM assistant_interactions WHERE record->>'outcome' = 'invalid_citation'",
      );
      expect(rejected.rows).toHaveLength(2);
      expect(rejected.rows[0]?.provider_output.claims).toHaveLength(1);
    } finally {
      await audit.end();
    }
  });

  it('rejects factual claims without citations', async () => {
    const before = calls.length;
    response = {
      output: {
        claims: [{ text: 'Uncited statement', citations: [] }],
        hypotheses: [],
        draft: null,
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-uncited',
      latencyMs: 7,
    };
    const generated = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      headers: key,
      payload: { kind: 'summary', actor: 'demo-operator' },
    });
    expect(generated.statusCode).toBe(422);
    expect(calls).toHaveLength(before + 2);
    const detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(
      detail.assistantInteractions.filter(
        (item: { outcome: string }) => item.outcome === 'invalid_response',
      ),
    ).toHaveLength(2);
  });

  it('publishes only an accepted draft on an explicit Operator command', async () => {
    response = {
      output: {
        claims: [
          {
            text: 'Payment authorization failures are elevated.',
            citations: [{ type: 'signal', id: signalId }],
          },
        ],
        hypotheses: [],
        draft: {
          text: 'We are investigating elevated payment authorization failures.',
          citations: [{ type: 'signal', id: signalId }],
        },
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-draft',
      latencyMs: 10,
    };
    const unauthorized = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      payload: { kind: 'status_draft', actor: 'demo-operator' },
    });
    expect(unauthorized.statusCode).toBe(403);
    const draft = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      headers: key,
      payload: { kind: 'status_draft', actor: 'demo-operator' },
    });
    expect(draft.statusCode).toBe(201);
    let detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(detail.publishedUpdates).toEqual([]);
    const path = `/api/v1/incidents/${incidentId}/assistant-interactions/${draft.json().id}/publish`;
    expect(
      (
        await api.inject({
          method: 'POST',
          url: path,
          payload: { actor: 'demo-operator' },
        })
      ).statusCode,
    ).toBe(403);
    const published = await api.inject({
      method: 'POST',
      url: path,
      headers: key,
      payload: { actor: 'demo-operator' },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().content).toBe(
      'We are investigating elevated payment authorization failures.',
    );
    expect(
      (
        await api.inject({
          method: 'POST',
          url: path,
          headers: key,
          payload: { actor: 'demo-operator' },
        })
      ).statusCode,
    ).toBe(409);
    detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(detail.publishedUpdates).toHaveLength(1);
    expect(
      detail.timelineEvents.some(
        (event: { id: string }) => event.id === published.json().id,
      ),
    ).toBe(false);
  });

  it('answers from a Customer Report while redacting its contact address', async () => {
    const submitted = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'assistant-report',
        subject: 'Checkout failed',
        message: `Checkout failed for me. ${'x'.repeat(970)} alice@example.com for details.`,
      },
    });
    expect(submitted.statusCode).toBe(202);
    const reportId = submitted.json().signal.id as string;
    const caseId = submitted.json().triageCase.id as string;
    let reviewTask: unknown = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      reviewTask = (
        await api.inject({
          method: 'GET',
          url: `/api/v1/triage-cases/${caseId}`,
        })
      ).json().reviewTask;
      if (reviewTask) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reviewTask).toBeTruthy();
    const resolved = await api.inject({
      method: 'POST',
      url: `/api/v1/review-tasks/${caseId}/resolve`,
      headers: key,
      payload: {
        actor: 'demo-operator',
        reason: 'Operator confirmed the disruption.',
        resolution: {
          type: 'create_incident',
          priority: 'P2',
          owningDomain: 'payments',
        },
      },
    });
    expect(resolved.statusCode).toBe(200);
    const reportIncidentId = resolved.json().incidentId as string;
    response = {
      output: {
        claims: [
          {
            text: 'A customer reported a checkout failure.',
            citations: [{ type: 'signal', id: reportId }],
          },
        ],
        hypotheses: [],
        draft: null,
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-report',
      latencyMs: 3,
    };
    const answer = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${reportIncidentId}/assistant-interactions`,
      headers: key,
      payload: {
        actor: 'demo-operator',
        kind: 'question',
        question: 'What did the customer report?',
      },
    });
    expect(answer.statusCode).toBe(201);
    const requestText = JSON.stringify(calls.at(-1));
    expect(requestText).toContain('Checkout failed for me');
    expect(requestText).not.toContain('alice');
    expect(requestText).not.toContain('alice@example.com');
  });

  it('rejects a status draft with an unknown citation', async () => {
    response = {
      output: {
        claims: [],
        hypotheses: [],
        draft: {
          text: 'Unsupported update.',
          citations: [{ type: 'signal', id: randomUUID() }],
        },
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-bad-draft',
      latencyMs: 9,
    };
    const generated = await api.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
      headers: key,
      payload: { kind: 'status_draft', actor: 'demo-operator' },
    });
    expect(generated.statusCode).toBe(422);
    const detail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(detail.publishedUpdates).toHaveLength(1);
  });

  it('limits provider attempts per minute', async () => {
    response = {
      output: {
        claims: [
          {
            text: 'The Signal is recorded.',
            citations: [{ type: 'signal', id: signalId }],
          },
        ],
        hypotheses: [],
        draft: null,
      },
      returnedModel: 'gpt-5.6-terra-snapshot',
      providerRequestId: 'resp-limit',
      latencyMs: 1,
    };
    const request = () =>
      api.inject({
        method: 'POST',
        url: `/api/v1/incidents/${incidentId}/assistant-interactions`,
        headers: key,
        payload: { kind: 'summary', actor: 'demo-operator' },
      });
    clock.set('2026-09-21T12:05:00.000Z');
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await request()).statusCode).toBe(201);
    expect((await request()).statusCode).toBe(429);
    clock.set('2026-09-21T12:06:00.000Z');
    expect((await request()).statusCode).toBe(201);
  });
});
