import {
  TriageQueueSchema,
  type TriageQueue,
} from '@incident-command-center/contracts';

export type TriageQueueConnectionMode = 'connecting' | 'live' | 'polling';

interface TriageQueueEvent {
  data: string;
}

interface TriageQueueEventSource {
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  addEventListener(
    type: 'triage-queue',
    listener: (event: TriageQueueEvent) => void,
  ): void;
  close(): void;
}

interface TriageQueueSubscriptionOptions {
  apiBaseUrl: string;
  onQueue(queue: TriageQueue): void;
  onMode(mode: TriageQueueConnectionMode): void;
  onError(message: string | null): void;
}

interface TriageQueueSubscriptionAdapters {
  createEventSource?(url: string): TriageQueueEventSource;
  fetchQueue?(url: string): Promise<TriageQueue>;
  schedulePolling?(callback: () => void): unknown;
  cancelPolling?(handle: unknown): void;
}

const defaultAdapters: Required<TriageQueueSubscriptionAdapters> = {
  createEventSource(url) {
    return new EventSource(url);
  },
  async fetchQueue(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Triage Queue request failed');
    return TriageQueueSchema.parse(await response.json());
  },
  schedulePolling(callback) {
    return setInterval(callback, 2_000);
  },
  cancelPolling(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export function subscribeToTriageQueue(
  options: TriageQueueSubscriptionOptions,
  adapters: TriageQueueSubscriptionAdapters = {},
): () => void {
  const runtime = { ...defaultAdapters, ...adapters };
  const queueUrl = `${options.apiBaseUrl}/api/v1/triage-cases`;
  const events = runtime.createEventSource(`${queueUrl}/events`);
  let reconnectFailures = 0;
  let pollingHandle: unknown;
  let disposed = false;

  const pollQueue = async (): Promise<void> => {
    try {
      options.onQueue(await runtime.fetchQueue(queueUrl));
      options.onError(null);
    } catch {
      options.onError(
        'Live updates are unavailable. Retrying the Triage Queue.',
      );
    }
  };

  const beginPolling = (): void => {
    if (pollingHandle !== undefined || disposed) return;
    events.close();
    options.onMode('polling');
    void pollQueue();
    pollingHandle = runtime.schedulePolling(() => void pollQueue());
  };

  events.addEventListener('triage-queue', (event) => {
    try {
      options.onQueue(TriageQueueSchema.parse(JSON.parse(event.data)));
      options.onError(null);
    } catch {
      beginPolling();
    }
  });
  events.onopen = () => {
    reconnectFailures = 0;
    options.onMode('live');
  };
  events.onerror = () => {
    reconnectFailures += 1;
    if (reconnectFailures === 1) {
      options.onMode('connecting');
      return;
    }
    beginPolling();
  };

  return () => {
    disposed = true;
    events.close();
    if (pollingHandle !== undefined) {
      runtime.cancelPolling(pollingHandle);
    }
  };
}
