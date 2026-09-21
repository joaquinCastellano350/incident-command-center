import type {
  HealthCheckJob,
  HealthCheckMessageV1,
  HealthStatus,
} from '@incident-command-center/contracts';

export interface HealthSystem {
  readiness(): Promise<HealthStatus>;
  submitHealthCheck(correlationId: string): Promise<HealthCheckJob>;
  findHealthCheck(id: string): Promise<HealthCheckJob | null>;
}

export interface TransactionalDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface HealthJobQueue {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(
    message: HealthCheckMessageV1,
    options: { id: string; transaction: TransactionalDatabase },
  ): Promise<void>;
  process(
    handler: (
      message: HealthCheckMessageV1,
      transaction: TransactionalDatabase,
    ) => Promise<void>,
  ): Promise<void>;
}
