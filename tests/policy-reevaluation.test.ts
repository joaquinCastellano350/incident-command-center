import {
  CAUTIOUS_AUTOMATION_THRESHOLDS,
  decideAutomation,
  decideExistingIncidentAutomation,
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

describe('Re-evaluation policy for an existing Incident', () => {
  const noPriorEffects = { assignmentFailed: false, pageAttempted: false };
  it('can authorize new assignment and page without recreating the Incident', () => {
    expect(
      decideExistingIncidentAutomation(
        judgments,
        true,
        {
          currentPriority: 'P1',
          status: 'open',
          primaryOwningDomain: 'unknown',
        },
        noPriorEffects,
      ).authorizedActions,
    ).toEqual(['assign_owner', 'page_on_call']);
  });

  it('honors Current Priority after a human downgrade', () => {
    expect(
      decideExistingIncidentAutomation(
        judgments,
        true,
        {
          currentPriority: 'P3',
          status: 'open',
          primaryOwningDomain: 'unknown',
        },
        noPriorEffects,
      ).authorizedActions,
    ).toEqual(['assign_owner']);
  });

  it('does not authorize new work on a resolved Incident', () => {
    expect(
      decideExistingIncidentAutomation(
        judgments,
        true,
        {
          currentPriority: 'P1',
          status: 'resolved',
          primaryOwningDomain: 'unknown',
        },
        noPriorEffects,
      ).authorizedActions,
    ).toEqual([]);
  });

  it('routes a new conflicting owning Domain to review without a new page', () => {
    const changed = {
      ...judgments,
      primaryOwningDomain: {
        choice: 'authentication' as const,
        confidence: 0.99,
        probabilities: judgments.primaryOwningDomain.probabilities.map(
          (item) => ({
            outcome: item.outcome,
            probability: item.outcome === 'authentication' ? 0.99 : 0.0025,
          }),
        ),
      },
    };
    const decision = decideExistingIncidentAutomation(
      changed,
      true,
      {
        currentPriority: 'P1',
        status: 'open',
        primaryOwningDomain: 'payments',
      },
      noPriorEffects,
    );
    expect(decision.authorizedActions).toEqual([]);
    expect(
      decision.rules.find((rule) => rule.action === 'assign_owner')
        ?.explanation,
    ).toContain('Operator review');
  });

  it('can page the current owner once without assigning it again', () => {
    const incident = {
      currentPriority: 'P1' as const,
      status: 'open' as const,
      primaryOwningDomain: 'payments' as const,
    };
    expect(
      decideExistingIncidentAutomation(
        judgments,
        true,
        incident,
        noPriorEffects,
      ).authorizedActions,
    ).toEqual(['page_on_call']);
    expect(
      decideExistingIncidentAutomation(judgments, true, incident, {
        assignmentFailed: false,
        pageAttempted: true,
      }).authorizedActions,
    ).toEqual([]);
  });

  it('the v2 policy raises the Evidence Sufficiency gate without altering earlier policy', () => {
    const borderline = {
      ...judgments,
      evidenceSufficiency: { yesProbability: 0.96 },
    };
    expect(
      decideAutomation(borderline, true, {
        outcome: 'no_match',
        incidentId: null,
      }).authorizedActions,
    ).toEqual(['create_incident', 'assign_owner', 'page_on_call']);
    expect(
      decideAutomation(
        borderline,
        true,
        { outcome: 'no_match', incidentId: null },
        CAUTIOUS_AUTOMATION_THRESHOLDS,
      ).authorizedActions,
    ).toEqual([]);
  });
});
