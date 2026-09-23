import { randomUUID } from 'node:crypto';

import { buildApi } from '../../apps/api/src/app.js';
import {
  DeterministicOperationalJudgmentProvider,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import { evaluateMonitoringAlertDeterministically } from '@incident-command-center/domain';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('Customer Reports at the ingestion-to-query seam', () => {
  const clock = new ManualClock('2026-09-21T12:04:00.000Z');
  const queueName = `customer-matching-${randomUUID()}`;
  const databaseName = `incident_test_${randomUUID().replaceAll('-', '_')}`;
  const adminUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  adminUrl.pathname = '/postgres';
  const isolatedUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const baseline = new DeterministicOperationalJudgmentProvider();
  let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
  let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
  let api: Awaited<ReturnType<typeof buildApi>>;
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
    worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      judgmentProvider: {
        async evaluate(input) {
          if (input.signal.sourceType !== 'customer_report')
            return baseline.evaluate(input);
          if (input.signal.facts.customerReference === null)
            return baseline.evaluate(input);
          const reference = input.signal.facts.customerReference;
          return {
            judgments: evaluateMonitoringAlertDeterministically({
              provider: 'test',
              sourceEventKey: 'test',
              sourceReference: 'test',
              metric: 'payment_authorization_failure_rate',
              threshold: 2,
              observedValue: 18,
              service: 'checkout-api',
              region: 'us-east',
              occurredAt: input.signal.occurredAt,
              evaluationWindowSeconds: 600,
            }),
            incidentMatches: input.candidates.map((candidate) => {
              const relationship =
                reference === 'cust-related'
                  ? 'related_distinct'
                  : reference === 'cust-unrelated'
                    ? 'unrelated'
                    : reference === 'cust-resolved'
                      ? input.signal.title?.includes(candidate.id)
                        ? 'same_incident'
                        : 'unrelated'
                      : 'same_incident';
              return {
                candidateIncidentId: candidate.id,
                judgment: {
                  choice: relationship,
                  probabilities: [
                    {
                      outcome: 'same_incident' as const,
                      probability:
                        relationship === 'same_incident' ? 0.99 : 0.005,
                    },
                    {
                      outcome: 'related_distinct' as const,
                      probability:
                        relationship === 'related_distinct' ? 0.99 : 0.005,
                    },
                    {
                      outcome: 'unrelated' as const,
                      probability: relationship === 'unrelated' ? 0.99 : 0.005,
                    },
                  ],
                },
              };
            }),
            mode: 'deterministic' as const,
            configuredModel: 'test-match-v1',
            resolvedModel: 'test-match-v1',
            providerRequestId: null,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            retryCount: 0,
          };
        },
      },
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

  it('links three independent reports to the payment Incident without another Incident or page', async () => {
    const alert = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: randomUUID(),
        sourceReference: 'payment-failure-alert',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: clock.now().toISOString(),
        evaluationWindowSeconds: 600,
      },
    });
    expect(alert.statusCode).toBe(202);
    const alertCaseId = alert.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${alertCaseId}`,
            })
          ).json().incidentId,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    const incidentId = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${alertCaseId}`,
      })
    ).json().incidentId as string;

    const reports = [
      ['cust-101', 'Checkout charged me but did not confirm the order'],
      ['cust-202', 'Payment authorization fails at checkout'],
      ['cust-303', 'Cannot pay for an order today'],
    ];
    for (const [customerReference, message] of reports) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/customer-reports',
        payload: {
          provider: 'northstar-support',
          sourceEventKey: randomUUID(),
          sourceReference: `support-${customerReference}`,
          subject: 'Checkout payment failure',
          message,
          customerReference,
          affectedOperation: 'payment_authorization',
          service: 'checkout-api',
          region: 'us-east',
          reportedAt: clock.now().toISOString(),
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().signal).toMatchObject({
        sourceType: 'customer_report',
        facts: {
          subject: 'Checkout payment failure',
          message,
          customerReference,
          affectedOperation: 'payment_authorization',
          reportedAt: clock.now().toISOString(),
        },
      });
      const caseId = response.json().triageCase.id as string;
      await expect
        .poll(
          async () =>
            (
              await api.inject({
                method: 'GET',
                url: `/api/v1/triage-cases/${caseId}`,
              })
            ).json().triageCase.status,
          { timeout: 15_000 },
        )
        .toBe('evidence_linked');
      const caseDetail = (
        await api.inject({
          method: 'GET',
          url: `/api/v1/triage-cases/${caseId}`,
        })
      ).json();
      expect(caseDetail).toMatchObject({
        incidentId,
        evaluation: {
          incidentMatches: [
            {
              candidateIncidentId: incidentId,
              judgment: { choice: 'same_incident' },
            },
          ],
        },
        policyDecision: { authorizedActions: ['create_evidence_link'] },
      });
    }

    const incident = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(incident.evidenceLinks).toHaveLength(3);
    expect(
      incident.evidenceLinks
        .map(
          (link: { signal: { facts: { customerReference: string } } }) =>
            link.signal.facts.customerReference,
        )
        .sort(),
    ).toEqual(['cust-101', 'cust-202', 'cust-303']);
    expect(
      incident.evidenceLinks.every(
        (link: {
          evaluation: {
            incidentMatches: Array<{ candidateIncidentId: string }>;
          };
        }) =>
          link.evaluation.incidentMatches.some(
            (match) => match.candidateIncidentId === incidentId,
          ),
      ),
    ).toBe(true);
    expect(
      incident.workflowActions.filter(
        (action: { type: string }) => action.type === 'page_on_call',
      ),
    ).toHaveLength(1);
    expect(
      (await api.inject({ method: 'GET', url: '/api/v1/triage-cases' }))
        .json()
        .items.filter(
          (item: { status: string }) => item.status === 'incident_created',
        ),
    ).toHaveLength(1);

    const replayPayload = {
      provider: 'northstar-support',
      sourceEventKey: `replay-${randomUUID()}`,
      sourceReference: 'support-replayed',
      subject: 'Checkout payment failure',
      message: 'Payment failed again',
      customerReference: 'cust-replayed',
      affectedOperation: 'payment_authorization',
      service: 'checkout-api',
      region: 'us-east',
      reportedAt: clock.now().toISOString(),
    };
    const replayResponses = await Promise.all(
      [1, 2].map(() =>
        api.inject({
          method: 'POST',
          url: '/api/v1/signals/customer-reports',
          payload: replayPayload,
        }),
      ),
    );
    expect(
      replayResponses.map((response) => response.statusCode).sort(),
    ).toEqual([200, 202]);
    expect(replayResponses[0]!.json().signal.id).toBe(
      replayResponses[1]!.json().signal.id,
    );
    const replayCaseId = replayResponses[0]!.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${replayCaseId}`,
            })
          ).json().triageCase.status,
        { timeout: 15_000 },
      )
      .toBe('evidence_linked');
    const afterReplay = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(afterReplay.evidenceLinks).toHaveLength(4);
    expect(
      afterReplay.evidenceLinks.filter(
        (item: { signal: { sourceReference: string } }) =>
          item.signal.sourceReference === 'support-replayed',
      ),
    ).toHaveLength(1);
    expect(
      afterReplay.workflowActions.filter(
        (action: { type: string }) => action.type === 'page_on_call',
      ),
    ).toHaveLength(1);

    const related = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'support-related',
        subject: 'Checkout payment question',
        message: 'Order completed but refund is delayed',
        customerReference: 'cust-related',
        affectedOperation: 'refund',
        service: 'checkout-api',
        region: 'us-east',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(related.statusCode).toBe(202);
    const relatedId = related.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${relatedId}`,
            })
          ).json().triageCase.status,
        { timeout: 15_000 },
      )
      .toBe('needs_review');
    const relatedDetail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${relatedId}`,
      })
    ).json();
    expect(relatedDetail.evaluation.incidentMatches[0].judgment.choice).toBe(
      'related_distinct',
    );
    expect(relatedDetail.reviewTask.reason).toContain('related but distinct');
    expect(relatedDetail.evidenceLink).toBeNull();

    const unrelated = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'support-unrelated',
        subject: 'Checkout payment question',
        message: 'A separate payment issue',
        customerReference: 'cust-unrelated',
        affectedOperation: 'payment_authorization',
        service: 'checkout-api',
        region: 'us-east',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(unrelated.statusCode).toBe(202);
    const unrelatedId = unrelated.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${unrelatedId}`,
            })
          ).json().triageCase.status,
        { timeout: 15_000 },
      )
      .toBe('incident_created');
    const unrelatedDetail = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${unrelatedId}`,
      })
    ).json();
    expect(unrelatedDetail.incidentId).not.toBe(incidentId);
    expect(unrelatedDetail.policyDecision.authorizedActions).toEqual([
      'create_incident',
      'assign_owner',
    ]);
    expect(
      unrelatedDetail.workflowActions.some(
        (action: { type: string }) => action.type === 'page_on_call',
      ),
    ).toBe(false);
  });

  it('rejects incomplete Customer Reports at the public ingestion boundary', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'incomplete',
        subject: 'Checkout',
        message: '  ',
        customerReference: 'cust-invalid',
        affectedOperation: 'payment_authorization',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid Customer Report');
  });

  it('preserves missing report context as unknown and routes vague evidence to review', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'vague-sign-in',
        subject: 'Sign-in acting strange',
        message: 'Sign-in has been acting strange.',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().signal).toMatchObject({
      sourceType: 'customer_report',
      service: 'unknown',
      region: null,
      facts: {
        customerReference: null,
        affectedOperation: null,
        reportedAt: null,
      },
    });
    const caseId = response.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${caseId}`,
            })
          ).json().triageCase.status,
        { timeout: 15_000 },
      )
      .toBe('needs_review');
    const detail = (
      await api.inject({ method: 'GET', url: `/api/v1/triage-cases/${caseId}` })
    ).json();
    expect(detail.reviewTask.urgency).toBe('standard');
    expect(detail.workflowActions).toEqual([]);
    expect(detail.evidenceLink).toBeNull();
  });

  it('evaluates at most five ranked candidates from the active Incident pool', async () => {
    const incidentIds: string[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/monitoring-alerts',
        payload: {
          provider: 'northstar-monitoring',
          sourceEventKey: randomUUID(),
          sourceReference: `bounded-alert-${index}`,
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
      const caseId = response.json().triageCase.id as string;
      await expect
        .poll(
          async () =>
            (
              await api.inject({
                method: 'GET',
                url: `/api/v1/triage-cases/${caseId}`,
              })
            ).json().incidentId,
          { timeout: 15_000 },
        )
        .not.toBeNull();
      incidentIds.push(
        (
          await api.inject({
            method: 'GET',
            url: `/api/v1/triage-cases/${caseId}`,
          })
        ).json().incidentId,
      );
    }
    const targetIncidentId = incidentIds[0]!;
    const report = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'bounded-search',
        subject: targetIncidentId,
        message: 'Check whether this is related',
        customerReference: 'cust-related',
        affectedOperation: 'payment_authorization',
        service: 'checkout-api',
        region: 'us-east',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(report.statusCode).toBe(202);
    const caseId = report.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${caseId}`,
            })
          ).json().evaluation?.status,
        { timeout: 15_000 },
      )
      .toBe('succeeded');
    const detail = (
      await api.inject({ method: 'GET', url: `/api/v1/triage-cases/${caseId}` })
    ).json();
    expect(detail.evaluation.incidentMatches).toHaveLength(5);
    expect(
      detail.evaluation.incidentMatches.map(
        (match: { candidateIncidentId: string }) => match.candidateIncidentId,
      ),
    ).toContain(targetIncidentId);
  });

  it('links late evidence to a recently resolved Incident without reopening it', async () => {
    const alert = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: randomUUID(),
        sourceReference: 'resolved-alert',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: clock.now().toISOString(),
        evaluationWindowSeconds: 600,
      },
    });
    expect(alert.statusCode).toBe(202);
    const alertCaseId = alert.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${alertCaseId}`,
            })
          ).json().incidentId,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    const incidentId = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${alertCaseId}`,
      })
    ).json().incidentId as string;
    const pool = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      await pool.query(
        `UPDATE incidents SET record = jsonb_set(
           jsonb_set(record, '{status}', '"resolved"'::jsonb),
           '{resolvedAt}', to_jsonb($2::text)) WHERE id = $1`,
        [incidentId, clock.now().toISOString()],
      );
    } finally {
      await pool.end();
    }
    const report = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'late-report',
        subject: `Late evidence for ${incidentId}`,
        message: 'Checkout payment failed earlier',
        customerReference: 'cust-resolved',
        affectedOperation: 'payment_authorization',
        service: 'checkout-api',
        region: 'us-east',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(report.statusCode).toBe(202);
    const caseId = report.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${caseId}`,
            })
          ).json().triageCase.status,
        { timeout: 15_000 },
      )
      .toBe('evidence_linked');
    const triageDetail = (
      await api.inject({ method: 'GET', url: `/api/v1/triage-cases/${caseId}` })
    ).json();
    expect(triageDetail.incidentId).toBe(incidentId);
    expect(triageDetail.reviewTask.reason).toContain('resolved Incident');
    expect(
      triageDetail.workflowActions.map(
        (action: { type: string }) => action.type,
      ),
    ).toEqual(['create_evidence_link']);
    const incident = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/incidents/${incidentId}`,
      })
    ).json();
    expect(incident.incident.status).toBe('resolved');
    expect(
      incident.evidenceLinks.some(
        (item: { signal: { sourceReference: string } }) =>
          item.signal.sourceReference === 'late-report',
      ),
    ).toBe(true);
  });

  it('attaches one Evidence Link when two workers receive the same Signal', async () => {
    const alert = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/monitoring-alerts',
      payload: {
        provider: 'northstar-monitoring',
        sourceEventKey: randomUUID(),
        sourceReference: 'concurrent-alert',
        metric: 'payment_authorization_failure_rate',
        threshold: 2,
        observedValue: 18,
        service: 'checkout-api',
        region: 'us-east',
        occurredAt: clock.now().toISOString(),
        evaluationWindowSeconds: 600,
      },
    });
    expect(alert.statusCode).toBe(202);
    const alertCaseId = alert.json().triageCase.id as string;
    await expect
      .poll(
        async () =>
          (
            await api.inject({
              method: 'GET',
              url: `/api/v1/triage-cases/${alertCaseId}`,
            })
          ).json().incidentId,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    const incidentId = (
      await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${alertCaseId}`,
      })
    ).json().incidentId as string;

    await worker.stop();
    const matchingProvider = {
      async evaluate(input: Parameters<typeof baseline.evaluate>[0]) {
        const result = await baseline.evaluate(input);
        if (input.signal.sourceType !== 'customer_report') return result;
        return {
          ...result,
          judgments: evaluateMonitoringAlertDeterministically({
            provider: 'test',
            sourceEventKey: 'test',
            sourceReference: 'test',
            metric: 'payment_authorization_failure_rate',
            threshold: 2,
            observedValue: 18,
            service: 'checkout-api',
            region: 'us-east',
            occurredAt: input.signal.occurredAt,
            evaluationWindowSeconds: 600,
          }),
          incidentMatches: input.candidates.map((candidate) => {
            const same = candidate.id === incidentId;
            return {
              candidateIncidentId: candidate.id,
              judgment: {
                choice: same
                  ? ('same_incident' as const)
                  : ('unrelated' as const),
                probabilities: [
                  {
                    outcome: 'same_incident' as const,
                    probability: same ? 0.99 : 0.005,
                  },
                  { outcome: 'related_distinct' as const, probability: 0.005 },
                  {
                    outcome: 'unrelated' as const,
                    probability: same ? 0.005 : 0.99,
                  },
                ],
              },
            };
          }),
        };
      },
    };
    const report = await api.inject({
      method: 'POST',
      url: '/api/v1/signals/customer-reports',
      payload: {
        provider: 'northstar-support',
        sourceEventKey: randomUUID(),
        sourceReference: 'concurrent-report',
        subject: `Report for ${incidentId}`,
        message: 'Checkout payment failed',
        customerReference: 'cust-concurrent',
        affectedOperation: 'payment_authorization',
        service: 'checkout-api',
        region: 'us-east',
        reportedAt: clock.now().toISOString(),
      },
    });
    expect(report.statusCode).toBe(202);
    const triageCaseId = report.json().triageCase.id as string;
    const signalId = report.json().signal.id as string;
    const boss = new PgBoss({ connectionString: isolatedUrl.toString() });
    await boss.start();
    await boss.send(
      queueName,
      {
        version: 1,
        triageCaseId,
        signalId,
        correlationId: report.json().signal.correlationId,
      },
      { id: randomUUID() },
    );
    await boss.stop();

    worker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      judgmentProvider: matchingProvider,
    });
    const secondWorker = createPostgresTriageWorker({
      connectionString: isolatedUrl.toString(),
      queueName,
      clock,
      judgmentProvider: matchingProvider,
    });
    await Promise.all([worker.start(), secondWorker.start()]);
    try {
      await expect
        .poll(
          async () =>
            (
              await api.inject({
                method: 'GET',
                url: `/api/v1/triage-cases/${triageCaseId}`,
              })
            ).json().triageCase.status,
          { timeout: 15_000 },
        )
        .toBe('evidence_linked');
      const incident = (
        await api.inject({
          method: 'GET',
          url: `/api/v1/incidents/${incidentId}`,
        })
      ).json();
      expect(
        incident.evidenceLinks.filter(
          (item: { signal: { id: string } }) => item.signal.id === signalId,
        ),
      ).toHaveLength(1);
      expect(
        incident.workflowActions.filter(
          (action: { type: string; correlationId: string }) =>
            action.type === 'create_evidence_link' &&
            action.correlationId === report.json().signal.correlationId,
        ),
      ).toHaveLength(1);
    } finally {
      await secondWorker.stop();
    }
  });
});
