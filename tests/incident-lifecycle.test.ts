import { randomUUID } from 'node:crypto';

import { transitionIncidentLifecycle } from '@incident-command-center/domain';
import type { Incident } from '@incident-command-center/contracts';
import { describe, expect, it } from 'vitest';

const occurredAt = '2026-09-21T12:00:00.000Z';
const states = ['open', 'acknowledged', 'mitigated', 'resolved'] as const;
const allowed = new Set([
  'open:acknowledged',
  'acknowledged:mitigated',
  'mitigated:resolved',
  'resolved:open',
]);

function incident(status: Incident['status']): Incident {
  return {
    id: randomUUID(),
    title: 'Payment failures',
    status,
    resolvedAt: status === 'resolved' ? '2026-09-21T11:00:00.000Z' : null,
    currentPriority: 'P1',
    primaryOwningDomain: 'payments',
    createdAt: '2026-09-21T10:00:00.000Z',
    correlationId: randomUUID(),
  };
}

describe('Incident lifecycle', () => {
  for (const previous of states) {
    for (const next of states) {
      it(`${previous} to ${next}`, () => {
        const before = incident(previous);
        const transition = () =>
          transitionIncidentLifecycle(before, next, occurredAt);
        if (allowed.has(`${previous}:${next}`)) {
          expect(transition()).toEqual({
            ...before,
            status: next,
            resolvedAt: next === 'resolved' ? occurredAt : null,
          });
          expect(before.status).toBe(previous);
        } else {
          expect(transition).toThrow();
          expect(before.status).toBe(previous);
        }
      });
    }
  }
});
