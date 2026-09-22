import { z } from 'zod';

export const ComponentStatusSchema = z.enum(['ready', 'unavailable']);

export const HealthStatusSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  api: z.literal('ready'),
  database: ComponentStatusSchema,
  worker: ComponentStatusSchema,
  checkedAt: z.iso.datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthCheckResultSchema = z.object({
  message: z.string(),
  queue: z.string(),
});

export const HealthCheckJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'completed']),
  correlationId: z.uuid(),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  result: HealthCheckResultSchema.nullable(),
});

export type HealthCheckJob = z.infer<typeof HealthCheckJobSchema>;

export const HealthCheckMessageV1Schema = z.object({
  version: z.literal(1),
  healthJobId: z.uuid(),
  correlationId: z.uuid(),
});

export type HealthCheckMessageV1 = z.infer<typeof HealthCheckMessageV1Schema>;

export const MonitoringAlertInputSchema = z
  .object({
    provider: z.string().trim().min(1),
    sourceEventKey: z.string().trim().min(1),
    sourceReference: z.string().trim().min(1),
    metric: z.string().trim().min(1),
    threshold: z.number().finite(),
    observedValue: z.number().finite(),
    service: z.string().trim().min(1),
    region: z.enum(['us-east', 'eu-west', 'sa-east']),
    occurredAt: z.iso.datetime(),
    evaluationWindowSeconds: z.number().int().positive(),
    environment: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    rawFixtureReference: z.string().trim().min(1).optional(),
  })
  .strict();

export type MonitoringAlertInput = z.infer<typeof MonitoringAlertInputSchema>;

export const MonitoringAlertFactsSchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  observedValue: z.number(),
  evaluationWindowSeconds: z.number().int().positive(),
});

export const SignalSchema = z.object({
  id: z.uuid(),
  sourceType: z.literal('monitoring_alert'),
  provider: z.string(),
  sourceEventKey: z.string(),
  sourceReference: z.string(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  service: z.string(),
  environment: z.string().nullable(),
  region: z.string().nullable(),
  title: z.string().nullable(),
  content: z.string().nullable(),
  facts: MonitoringAlertFactsSchema,
  normalizationVersion: z.literal(1),
  rawFixtureReference: z.string().nullable(),
  correlationId: z.uuid(),
});

export type Signal = z.infer<typeof SignalSchema>;

export const TriageCaseStatusSchema = z.enum([
  'queued',
  'ready_for_evaluation',
]);

export const TriageCaseSchema = z.object({
  id: z.uuid(),
  signalId: z.uuid(),
  status: TriageCaseStatusSchema,
  sourceReference: z.string(),
  service: z.string(),
  region: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  correlationId: z.uuid(),
});

export type TriageCase = z.infer<typeof TriageCaseSchema>;

export const MonitoringAlertIngestionResultSchema = z.object({
  signal: SignalSchema,
  triageCase: TriageCaseSchema,
  deduplicated: z.boolean(),
});

export type MonitoringAlertIngestionResult = z.infer<
  typeof MonitoringAlertIngestionResultSchema
>;

export const TriageQueueSchema = z.object({
  items: z.array(TriageCaseSchema),
});

export type TriageQueue = z.infer<typeof TriageQueueSchema>;

export const TriageJobMessageV1Schema = z.object({
  version: z.literal(1),
  triageCaseId: z.uuid(),
  signalId: z.uuid(),
  correlationId: z.uuid(),
});

export type TriageJobMessageV1 = z.infer<typeof TriageJobMessageV1Schema>;
