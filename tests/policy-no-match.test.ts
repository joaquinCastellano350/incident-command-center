import {
  decideAutomation,
  evaluateMonitoringAlertDeterministically,
} from '../packages/domain/src/index.js';
import { describe, expect, it } from 'vitest';

const judgments = evaluateMonitoringAlertDeterministically({
  provider: 'northstar-monitoring',
  sourceEventKey: 'alert-1',
  sourceReference: 'mon-1',
  metric: 'payment_authorization_failure_rate',
  threshold: 2,
  observedValue: 18,
  service: 'checkout-api',
  region: 'us-east',
  occurredAt: '2026-09-21T12:04:00.000Z',
  evaluationWindowSeconds: 600,
});

describe('candidate Incident decision gate', () => {
  it('authorizes a new Incident when no candidate matches', () => {
    expect(
      decideAutomation(judgments, true, {
        outcome: 'no_match',
        incidentId: null,
      }).authorizedActions,
    ).toEqual(['create_incident', 'assign_owner', 'page_on_call']);
  });

  it('withholds a new Incident and page when a candidate may match', () => {
    const decision = decideAutomation(judgments, true, {
      outcome: 'review',
      incidentId: null,
    });
    expect(decision.authorizedActions).toEqual([]);
    expect(
      decision.rules.find((rule) => rule.action === 'create_incident'),
    ).toMatchObject({ outcome: 'denied' });
  });
});
