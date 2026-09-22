import { randomUUID } from 'node:crypto';

import {
  JevOperationalJudgmentProvider,
  LiveJevTransport,
} from '../../packages/adapters/src/jev.js';
import { EvaluationInputSchema } from '@incident-command-center/contracts';
import { describe, expect, it } from 'vitest';

const describeLive =
  process.env.LIVE_JEV_SMOKE === '1' && process.env.TYPESAFE_API_KEY
    ? describe
    : describe.skip;

describeLive('live Jev provider contract', () => {
  it('returns the typed answer set and complete probability distributions', async () => {
    const input = EvaluationInputSchema.parse({
      signal: {
        id: randomUUID(),
        sourceType: 'monitoring_alert',
        provider: 'northstar-monitoring',
        sourceEventKey: randomUUID(),
        sourceReference: 'smoke-checkout-alert',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        service: 'checkout-api',
        region: 'us-east',
        environment: 'synthetic',
        title: 'Payment authorization failure rate increased',
        content:
          '18 percent failures against 2 percent threshold after deployment.',
        normalizationVersion: 1,
        rawFixtureReference: null,
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
      candidates: [],
    });
    const result = await new JevOperationalJudgmentProvider(
      new LiveJevTransport(process.env.TYPESAFE_API_KEY!),
      'live',
      'jev-1.13.0',
      15_000,
    ).evaluate(input);

    expect(result.mode).toBe('live');
    expect(result.resolvedModel).toMatch(/^jev-/);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.judgments.priorityAssessment.probabilities).toHaveLength(4);
    expect(result.judgments.customerReach.probabilities).toHaveLength(4);
    expect(result.judgments.regionalReach.probabilities).toHaveLength(5);
    expect(result.judgments.serviceBreadth.probabilities).toHaveLength(4);
    expect(result.judgments.primaryOwningDomain.probabilities).toHaveLength(5);
    expect(
      result.judgments.evidenceSufficiency.yesProbability,
    ).toBeGreaterThanOrEqual(0);
  });
});
