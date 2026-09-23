import {
  decideAutomation,
  decideIncidentRelationship,
  evaluateMonitoringAlertDeterministically,
} from '../packages/domain/src/index.js';
import type { OperationalJudgmentResult } from '@incident-command-center/domain';
import type { OperationalJudgments } from '@incident-command-center/contracts';
import { describe, expect, it } from 'vitest';

type Match =
  OperationalJudgmentResult<OperationalJudgments>['incidentMatches'][number];

function match(
  candidateIncidentId: string,
  choice: Match['judgment']['choice'],
  probability: number,
): Match {
  const remainder = (1 - probability) / 2;
  return {
    candidateIncidentId,
    judgment: {
      choice,
      probabilities: (
        ['same_incident', 'related_distinct', 'unrelated'] as const
      ).map((outcome) => ({
        outcome,
        probability: outcome === choice ? probability : remainder,
      })),
    },
  };
}

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

describe('Incident Match policy', () => {
  it('authorizes a link for one confident same-Incident choice without creating or paging', () => {
    const relationship = decideIncidentRelationship(
      ['incident-1', 'incident-2'],
      [
        match('incident-1', 'same_incident', 0.97),
        match('incident-2', 'unrelated', 0.98),
      ],
    );
    expect(relationship).toEqual({
      outcome: 'same_incident',
      incidentId: 'incident-1',
    });
    expect(
      decideAutomation(judgments, true, relationship).authorizedActions,
    ).toEqual(['create_evidence_link']);
  });

  it.each([
    {
      label: 'related but distinct',
      choices: [match('incident-1', 'related_distinct', 0.99)],
    },
    {
      label: 'uncertain',
      choices: [match('incident-1', 'same_incident', 0.96)],
    },
    {
      label: 'two same-Incident candidates',
      choices: [
        match('incident-1', 'same_incident', 0.99),
        match('incident-2', 'same_incident', 0.99),
      ],
    },
    { label: 'missing candidate judgment', choices: [] },
    {
      label: 'duplicated candidate judgment',
      choices: [
        match('incident-1', 'same_incident', 0.99),
        match('incident-1', 'same_incident', 0.99),
      ],
    },
  ])('sends $label to review', ({ choices }) => {
    const candidateIds =
      choices.length === 2 ? ['incident-1', 'incident-2'] : ['incident-1'];
    expect(decideIncidentRelationship(candidateIds, choices).outcome).toBe(
      'review',
    );
  });

  it('derives no-match only when every candidate is confidently unrelated', () => {
    expect(
      decideIncidentRelationship(
        ['incident-1'],
        [match('incident-1', 'unrelated', 0.97)],
      ),
    ).toEqual({ outcome: 'no_match', incidentId: null });
    expect(
      decideIncidentRelationship(
        ['incident-1'],
        [match('incident-1', 'unrelated', 0.96)],
      ).outcome,
    ).toBe('review');
  });

  it('requires Evidence Sufficiency independently of a confident Incident Match', () => {
    const lowEvidence = {
      ...judgments,
      evidenceSufficiency: { yesProbability: 0.94 },
    };
    expect(
      decideAutomation(lowEvidence, false, {
        outcome: 'same_incident',
        incidentId: 'incident-1',
      }).authorizedActions,
    ).toEqual([]);
  });
});
