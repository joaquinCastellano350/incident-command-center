import { describe, expect, it } from 'vitest';
import { LogAnomalyInputSchema } from '../packages/contracts/src/index.js';

const payload = {
  provider: 'northstar-logs',
  sourceEventKey: 'log-1',
  sourceReference: 'logs-checkout-1',
  service: 'checkout-api',
  region: 'us-east',
  errorSignature: 'PaymentAuthorizationTimeout',
  occurrenceCount: 28,
  sampleMessages: ['Authorization timed out', 'Payment request failed'],
  windowStartedAt: '2026-09-21T12:00:00.000Z',
  windowEndedAt: '2026-09-21T12:05:00.000Z',
};

describe('Log Anomaly input contract', () => {
  it('accepts a bounded error observation', () => {
    expect(LogAnomalyInputSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ['service', ''],
    ['region', 'elsewhere'],
    ['errorSignature', ''],
    ['occurrenceCount', 0],
    ['occurrenceCount', 1.5],
    ['sampleMessages', []],
    ['sampleMessages', ['']],
    ['windowStartedAt', 'bad-date'],
    ['windowEndedAt', '2026-09-21T11:59:00.000Z'],
    ['windowEndedAt', '2026-09-21T12:00:00.000Z'],
  ])('rejects invalid %s', (field, value) => {
    expect(
      LogAnomalyInputSchema.safeParse({ ...payload, [field]: value }).success,
    ).toBe(false);
  });
});
