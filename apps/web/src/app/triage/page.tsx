import {
  TriageQueueSchema,
  type TriageQueue,
} from '@incident-command-center/contracts';

import { TriageQueueView } from './triage-queue';

export const dynamic = 'force-dynamic';

async function loadTriageQueue(apiBaseUrl: string): Promise<TriageQueue> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/triage-cases`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error('Triage Queue request failed');
    }
    return TriageQueueSchema.parse(await response.json());
  } catch {
    return { items: [] };
  }
}

export default async function TriagePage() {
  const internalApiBaseUrl = process.env.API_INTERNAL_BASE_URL!;
  const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL!;
  const initialQueue = await loadTriageQueue(internalApiBaseUrl);

  return (
    <TriageQueueView
      apiBaseUrl={publicApiBaseUrl}
      initialQueue={initialQueue}
    />
  );
}
