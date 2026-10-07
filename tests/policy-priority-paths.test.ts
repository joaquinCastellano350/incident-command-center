import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { OperationalJudgments } from '@incident-command-center/contracts';
import {
  decideAutomation,
  decideExistingIncidentAutomation,
  evaluateMonitoringAlertDeterministically,
} from '../packages/domain/src/index.js';

const baseline = evaluateMonitoringAlertDeterministically({
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
const noMatch = { outcome: 'no_match' as const, incidentId: null };

function withPriority(
  priority: 'P0' | 'P1' | 'P2' | 'P3',
): OperationalJudgments {
  return {
    ...baseline,
    priorityAssessment: {
      choice: priority,
      probabilities: (['P0', 'P1', 'P2', 'P3'] as const).map((outcome) => ({
        outcome,
        probability: outcome === priority ? 0.99 : 0.01 / 3,
      })),
    },
  };
}

describe('priority and Evidence Sufficiency policy', () => {
  it.each([
    ['P0', ['create_incident', 'assign_owner', 'page_on_call']],
    ['P1', ['create_incident', 'assign_owner', 'page_on_call']],
    ['P2', ['create_incident', 'assign_owner']],
    ['P3', []],
  ] as const)('%s permits only its bounded actions', (priority, actions) => {
    expect(
      decideAutomation(withPriority(priority), true, noMatch).authorizedActions,
    ).toEqual(actions);
  });

  it.each([0.949, 0.95, 0.98])(
    'applies the Evidence Sufficiency boundary at %s',
    (yesProbability) => {
      const decision = decideAutomation(
        {
          ...withPriority('P2'),
          evidenceSufficiency: { yesProbability },
        },
        true,
        noMatch,
      );
      expect(decision.authorizedActions).toEqual(
        yesProbability < 0.95 ? [] : ['create_incident', 'assign_owner'],
      );
    },
  );

  it('P3 never pages across evidence, ownership, and corroboration', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        (yesProbability, corroborated, knownOwner) => {
          const judgments = withPriority('P3');
          judgments.evidenceSufficiency = { yesProbability };
          if (!knownOwner)
            judgments.primaryOwningDomain = {
              ...judgments.primaryOwningDomain,
              choice: 'unknown',
            };
          expect(
            decideAutomation(judgments, corroborated, noMatch)
              .authorizedActions,
          ).not.toContain('page_on_call');
        },
      ),
    );
  });

  it('a P3 re-evaluation never pages an existing high-priority Incident', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('P0', 'P1'),
        fc.boolean(),
        (currentPriority, alreadyAssigned) => {
          const actions = decideExistingIncidentAutomation(
            withPriority('P3'),
            true,
            {
              currentPriority,
              status: 'open',
              primaryOwningDomain: alreadyAssigned ? 'payments' : 'unknown',
            },
            { assignmentFailed: false, pageAttempted: false },
          ).authorizedActions;
          expect(actions).not.toContain('page_on_call');
        },
      ),
    );
  });

  it('confidence in other judgments cannot bypass a missing action prerequisite', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('evidence', 'owner', 'impact', 'corroboration'),
        fc.constantFrom('P0', 'P1'),
        (missing, priority) => {
          const judgments = withPriority(priority);
          if (missing === 'evidence')
            judgments.evidenceSufficiency = { yesProbability: 0.949 };
          if (missing === 'owner')
            judgments.primaryOwningDomain = {
              ...judgments.primaryOwningDomain,
              choice: 'unknown',
            };
          if (missing === 'impact')
            judgments.customerReach = {
              ...judgments.customerReach,
              choice: 'unknown',
            };
          const actions = decideAutomation(
            judgments,
            missing !== 'corroboration',
            noMatch,
          ).authorizedActions;
          expect(actions).not.toContain('page_on_call');
          if (missing === 'evidence' || missing === 'impact')
            expect(actions).not.toContain('create_incident');
          if (missing === 'owner')
            expect(actions).not.toContain('assign_owner');
        },
      ),
    );
  });
});
