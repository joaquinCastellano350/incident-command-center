import { subscribeToTriageQueue } from '../apps/web/src/app/triage/triage-queue-client.js';
import { describe, expect, it } from 'vitest';

class ControlledEventSource {
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  #listener?: (event: { data: string }) => void;

  addEventListener(
    _type: 'triage-queue',
    listener: (event: { data: string }) => void,
  ): void {
    this.#listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emitQueue(data: string): void {
    this.#listener?.({ data });
  }
}

describe('Triage Queue live updates', () => {
  it('recovers one SSE disconnect and polls only after reconnect failure', async () => {
    const events = new ControlledEventSource();
    const modes: string[] = [];
    const queues: unknown[] = [];
    let fetchCount = 0;
    let pollingScheduled = false;
    let pollingCancelled = false;

    const stop = subscribeToTriageQueue(
      {
        apiBaseUrl: 'http://api.example.test',
        onQueue: (queue) => queues.push(queue),
        onMode: (mode) => modes.push(mode),
        onError: () => {},
      },
      {
        createEventSource: () => events,
        fetchQueue: async () => {
          fetchCount += 1;
          return { items: [] };
        },
        schedulePolling: () => {
          pollingScheduled = true;
          return 'polling-handle';
        },
        cancelPolling: () => {
          pollingCancelled = true;
        },
      },
    );

    events.onopen?.(new Event('open'));
    events.onerror?.(new Event('error'));
    expect(modes).toEqual(['live', 'connecting']);
    expect(events.closed).toBe(false);
    expect(fetchCount).toBe(0);

    events.onopen?.(new Event('open'));
    events.onerror?.(new Event('error'));
    expect(modes).toEqual(['live', 'connecting', 'live', 'connecting']);
    expect(events.closed).toBe(false);
    expect(fetchCount).toBe(0);

    events.onerror?.(new Event('error'));
    await expect.poll(() => fetchCount).toBe(1);
    expect(modes.at(-1)).toBe('polling');
    expect(events.closed).toBe(true);
    expect(pollingScheduled).toBe(true);
    expect(queues).toEqual([{ items: [] }]);

    stop();
    expect(pollingCancelled).toBe(true);
  });
});
