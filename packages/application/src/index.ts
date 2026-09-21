import type {
  HealthCheckJob,
  HealthStatus,
} from '@incident-command-center/contracts';

export interface HealthSystem {
  readiness(): Promise<HealthStatus>;
  submitHealthCheck(correlationId: string): Promise<HealthCheckJob>;
  findHealthCheck(id: string): Promise<HealthCheckJob | null>;
}
