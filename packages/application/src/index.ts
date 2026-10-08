import type {
  HealthCheckJob,
  HealthCheckMessageV1,
  HealthStatus,
  IncidentDetail,
  IncidentLifecycleCommand,
  DeploymentEventIngestionResult,
  DeploymentEventInput,
  CustomerReportIngestionResult,
  CustomerReportInput,
  MonitoringAlertIngestionResult,
  MonitoringAlertInput,
  LogAnomalyIngestionResult,
  LogAnomalyInput,
  TriageCase,
  TriageCaseDetail,
  TriageJobMessageV1,
  ReviewQueue,
  ReviewCommand,
  PriorityOverrideCommand,
  ReevaluationCommand,
  AssistantCommand,
  AssistantInteraction,
  PublishedUpdate,
  AssistantEvidence,
  AssistantOutput,
} from '@incident-command-center/contracts';

export interface AssistantProviderRequest {
  model: string;
  configurationVersion: string;
  command: AssistantCommand;
  evidence: AssistantEvidence;
}

export interface AssistantProviderResult {
  output: AssistantOutput;
  returnedModel: string;
  providerRequestId: string | null;
  latencyMs: number;
}

export interface AssistantProvider {
  generate(request: AssistantProviderRequest): Promise<AssistantProviderResult>;
}

export interface AssistantSystem {
  generate(
    incidentId: string,
    command: AssistantCommand,
  ): Promise<AssistantInteraction | null>;
  publish(
    incidentId: string,
    interactionId: string,
    actor: 'demo-operator',
  ): Promise<PublishedUpdate | null>;
}

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

export interface TriageSystem {
  ingestLogAnomaly(
    input: LogAnomalyInput,
    correlationId: string,
  ): Promise<LogAnomalyIngestionResult>;
  ingestCustomerReport(
    input: CustomerReportInput,
    correlationId: string,
  ): Promise<CustomerReportIngestionResult>;
  ingestMonitoringAlert(
    input: MonitoringAlertInput,
    correlationId: string,
  ): Promise<MonitoringAlertIngestionResult>;
  ingestDeploymentEvent(
    input: DeploymentEventInput,
    correlationId: string,
  ): Promise<DeploymentEventIngestionResult>;
  listTriageCases(): Promise<TriageCase[]>;
  findTriageCase(id: string): Promise<TriageCaseDetail | null>;
  findIncident(id: string): Promise<IncidentDetail | null>;
  transitionIncident(
    id: string,
    command: IncidentLifecycleCommand,
    correlationId: string,
  ): Promise<IncidentDetail | null>;
  listReviewTasks(): Promise<ReviewQueue>;
  resolveReview(
    id: string,
    command: ReviewCommand,
  ): Promise<TriageCaseDetail | null>;
  overridePriority(
    id: string,
    command: PriorityOverrideCommand,
  ): Promise<IncidentDetail | null>;
  requestReevaluation(
    id: string,
    command: ReevaluationCommand,
    correlationId: string,
  ): Promise<TriageCaseDetail | null>;
}

export interface TriageJobQueue {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(
    message: TriageJobMessageV1,
    options: { id: string; transaction: TransactionalDatabase },
  ): Promise<void>;
  process(
    handler: (
      message: TriageJobMessageV1,
      transaction: TransactionalDatabase,
    ) => Promise<void>,
  ): Promise<void>;
}
