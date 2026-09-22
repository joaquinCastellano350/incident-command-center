import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  JevEvaluationFailure,
  JevOperationalJudgmentProvider,
  RecordedJevTransport,
  buildJevRequest,
  type JevTransport,
} from '../packages/adapters/src/jev.js';
import {
  EvaluationInputSchema,
  IncidentSchema,
} from '@incident-command-center/contracts';
import { describe, expect, it } from 'vitest';

const fixture = EvaluationInputSchema.parse({
  signal: {
    id: randomUUID(),
    sourceType: 'monitoring_alert',
    provider: 'northstar-monitoring',
    sourceEventKey: 'alert-1',
    sourceReference: 'mon-1',
    occurredAt: '2026-09-21T12:04:00.000Z',
    receivedAt: '2026-09-21T12:04:05.000Z',
    service: 'checkout-api',
    region: 'us-east',
    environment: 'production',
    title: 'Payment authorization failures',
    content: '18 percent of payments fail',
    normalizationVersion: 1,
    rawFixtureReference: 'private-fixture-path',
    correlationId: randomUUID(),
    facts: {
      metric: 'payment_authorization_failure_rate',
      threshold: 2,
      observedValue: 18,
      evaluationWindowSeconds: 600,
    },
  },
  corroboratingFacts: [
    {
      kind: 'threshold_breach',
      summary: '18 percent against 2 percent threshold',
      evidenceSignalIds: [randomUUID()],
    },
  ],
  candidates: [
    {
      id: randomUUID(),
      title: 'Checkout degraded',
      service: 'checkout-api',
      region: 'us-east',
      status: 'open',
      currentPriority: 'P1',
      primaryOwningDomain: 'payments',
    },
  ],
});

describe('TypeSafe Jev contract', () => {
  it('can evaluate a recently resolved Incident candidate', () => {
    const incident = IncidentSchema.parse({
      id: fixture.candidates[0]!.id,
      title: 'Checkout degraded',
      status: 'resolved',
      resolvedAt: '2026-09-21T11:45:00.000Z',
      currentPriority: 'P1',
      primaryOwningDomain: 'payments',
      createdAt: '2026-09-21T11:00:00.000Z',
      correlationId: randomUUID(),
    });
    const input = EvaluationInputSchema.parse({
      ...fixture,
      candidates: [{ ...fixture.candidates[0], ...incident }],
    });
    const request = buildJevRequest(input);
    expect(request.state.candidates[0]).toMatchObject({
      status: 'resolved',
      resolvedAt: incident.resolvedAt,
    });
    expect(request.questions.incidentMatch_0).toMatchObject({ type: 'choice' });
  });

  it('builds and replays the typed question set for a Deployment Event Triage Case', async () => {
    const deployment = EvaluationInputSchema.parse({
      signal: {
        id: randomUUID(),
        sourceType: 'deployment_event',
        provider: 'northstar-deployments',
        sourceEventKey: 'deploy-1',
        sourceReference: 'deploy-checkout-1',
        occurredAt: '2026-09-21T12:00:00.000Z',
        receivedAt: '2026-09-21T12:00:05.000Z',
        service: 'checkout-api',
        region: 'us-east',
        environment: 'production',
        title: 'Checkout deployment',
        content: null,
        normalizationVersion: 1,
        rawFixtureReference: null,
        correlationId: randomUUID(),
        facts: {
          version: '2026.09.20.3',
          commitReference: 'abc123',
          deployer: 'release-bot',
          outcome: 'succeeded',
        },
      },
      corroboratingFacts: [],
      candidates: [],
    });
    const request = buildJevRequest(deployment);
    expect(request.state.signal.facts).toMatchObject({
      version: '2026.09.20.3',
      outcome: 'succeeded',
    });
    expect(Object.keys(request.questions)).toHaveLength(6);
    const recordings = JSON.parse(
      await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
    );
    const result = await new JevOperationalJudgmentProvider(
      new RecordedJevTransport(recordings),
      'recorded',
    ).evaluate(deployment);
    expect(result.judgments.priorityAssessment.choice).toBe('P3');
    expect(result.judgments.evidenceSufficiency.yesProbability).toBe(0.2);
  });

  it('sends one request with normalized state and all typed questions', () => {
    const request = buildJevRequest(fixture);
    expect(request.model).toBe('jev-1.13.0');
    expect(request.state).toMatchObject({
      signal: { id: fixture.signal.id, facts: fixture.signal.facts },
      taxonomy: {
        domains: ['payments', 'authentication', 'fulfillment', 'platform'],
      },
      corroboratingFacts: fixture.corroboratingFacts,
      candidates: fixture.candidates,
    });
    expect(JSON.stringify(request.state)).not.toContain('private-fixture-path');
    expect(Object.keys(request.questions)).toEqual([
      'priorityAssessment',
      'customerReach',
      'regionalReach',
      'serviceBreadth',
      'primaryOwningDomain',
      'evidenceSufficiency',
      'incidentMatch_0',
    ]);
    expect(request.questions.evidenceSufficiency).toMatchObject({
      type: 'noul',
    });
    expect(request.questions.incidentMatch_0).toMatchObject({ type: 'choice' });
    expect(JSON.stringify(request.questions)).not.toMatch(
      /recommend|authorize|execute|route.*workflow/i,
    );
  });

  it('preserves every Choice probability, Noul value, candidate match, and retry metadata', async () => {
    const response = JSON.parse(
      await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
    )[0].body;
    response.answers.incidentMatch_0 = {
      type: 'choice',
      choice: 'same_incident',
      confidence: 0.97,
      probabilities: {
        same_incident: 0.97,
        related_distinct: 0.02,
        unrelated: 0.01,
      },
    };
    const requests: unknown[] = [];
    const transport: JevTransport = {
      async send(request) {
        requests.push(request);
        if (requests.length < 3)
          return { status: 529, body: {}, requestId: `req-${requests.length}` };
        return { status: 200, body: response, requestId: 'req-3' };
      },
    };
    const result = await new JevOperationalJudgmentProvider(
      transport,
      'live',
      'jev-1.13.0',
      5000,
    ).evaluate(fixture);
    expect(requests).toHaveLength(3);
    expect(result).toMatchObject({
      mode: 'live',
      providerRequestId: 'req-3',
      configuredModel: 'jev-1.13.0',
      resolvedModel: 'jev-1.13.0',
      retryCount: 2,
      inputTokens: 512,
      outputTokens: 96,
      judgments: {
        priorityAssessment: { choice: 'P1' },
        evidenceSufficiency: { yesProbability: 0.99 },
      },
      incidentMatches: [
        {
          candidateIncidentId: fixture.candidates[0]!.id,
          judgment: { choice: 'same_incident' },
        },
      ],
    });
    expect(result.judgments.primaryOwningDomain.probabilities).toHaveLength(5);
    expect(result.judgments.priorityAssessment.confidence).toBe(0.98);
    expect(result.incidentMatches[0]?.judgment.probabilities).toHaveLength(3);
  });

  it('replays a matching recorded candidate Evaluation through the same port', async () => {
    const body = JSON.parse(
      await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
    )[0].body;
    body.answers.incidentMatch_0 = {
      type: 'choice',
      choice: 'same_incident',
      confidence: 0.97,
      probabilities: {
        same_incident: 0.97,
        related_distinct: 0.02,
        unrelated: 0.01,
      },
    };
    const transport = new RecordedJevTransport([
      {
        body,
        requestId: 'recorded:matched',
        expectedSignal: {
          sourceType: 'monitoring_alert',
          service: fixture.signal.service,
          region: fixture.signal.region,
          facts: {
            metric: 'payment_authorization_failure_rate',
            threshold: 2,
            observedValue: 18,
          },
        },
        expectedCandidateIds: [fixture.candidates[0]!.id],
        expectedCorroboratingKinds: ['threshold_breach'],
      },
    ]);
    const result = await new JevOperationalJudgmentProvider(
      transport,
      'recorded',
    ).evaluate(fixture);
    expect(result.mode).toBe('recorded');
    expect(result.incidentMatches[0]).toMatchObject({
      candidateIncidentId: fixture.candidates[0]!.id,
      judgment: { choice: 'same_incident', confidence: 0.97 },
    });
  });

  it('rejects an incomplete distribution as an invalid provider result', async () => {
    const response = JSON.parse(
      await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
    )[0].body;
    delete response.answers.priorityAssessment.probabilities.P0;
    const transport: JevTransport = {
      async send() {
        return { status: 200, body: response, requestId: 'req-invalid' };
      },
    };
    await expect(
      new JevOperationalJudgmentProvider(transport, 'recorded').evaluate({
        ...fixture,
        candidates: [],
      }),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
      metadata: { providerRequestId: 'req-invalid' },
    } satisfies Partial<JevEvaluationFailure>);
  });

  it('ends a stalled provider call at the application deadline', async () => {
    const transport: JevTransport = {
      async send(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const start = performance.now();
    await expect(
      new JevOperationalJudgmentProvider(
        transport,
        'live',
        'jev-1.13.0',
        50,
      ).evaluate(fixture),
    ).rejects.toMatchObject({
      kind: 'deadline',
      metadata: { retryCount: 0 },
    } satisfies Partial<JevEvaluationFailure>);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
