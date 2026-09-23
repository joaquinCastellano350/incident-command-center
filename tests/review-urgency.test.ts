import { reviewUrgency } from '@incident-command-center/domain';
import { describe, expect, it } from 'vitest';

describe('Review Urgency', () => {
  it.each([
    [null, false, true, 'urgent'],
    [
      {
        choice: 'P3',
        probabilities: [
          { outcome: 'P0', probability: 0.1 },
          { outcome: 'P1', probability: 0.1 },
          { outcome: 'P2', probability: 0.1 },
          { outcome: 'P3', probability: 0.7 },
        ],
      },
      false,
      false,
      'standard',
    ],
    [
      {
        choice: 'P2',
        probabilities: [
          { outcome: 'P0', probability: 0.15 },
          { outcome: 'P1', probability: 0.15 },
          { outcome: 'P2', probability: 0.6 },
          { outcome: 'P3', probability: 0.1 },
        ],
      },
      false,
      false,
      'urgent',
    ],
    [
      {
        choice: 'P3',
        probabilities: [
          { outcome: 'P0', probability: 0.1 },
          { outcome: 'P1', probability: 0.1 },
          { outcome: 'P2', probability: 0.1 },
          { outcome: 'P3', probability: 0.7 },
        ],
      },
      true,
      false,
      'urgent',
    ],
  ] as const)(
    'derives urgency from probability, corroboration, and failure',
    (priority, corroborated, failedHighImpactAction, expected) => {
      expect(
        reviewUrgency(priority, corroborated, failedHighImpactAction),
      ).toBe(expected);
    },
  );
});
