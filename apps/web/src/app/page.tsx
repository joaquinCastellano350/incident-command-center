import {
  HealthStatusSchema,
  type HealthStatus,
} from '@incident-command-center/contracts';

import { HealthDashboard } from './health-dashboard';

export const dynamic = 'force-dynamic';

async function loadHealth(apiBaseUrl: string): Promise<HealthStatus> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/health`, {
      cache: 'no-store',
    });
    return HealthStatusSchema.parse(await response.json());
  } catch {
    return {
      status: 'degraded',
      api: 'ready',
      database: 'unavailable',
      worker: 'unavailable',
      checkedAt: new Date().toISOString(),
    };
  }
}

export default async function HomePage() {
  const internalApiBaseUrl = process.env.API_INTERNAL_BASE_URL!;
  const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL!;
  const initialHealth = await loadHealth(internalApiBaseUrl);

  return (
    <HealthDashboard
      apiBaseUrl={publicApiBaseUrl}
      initialHealth={initialHealth}
    />
  );
}
