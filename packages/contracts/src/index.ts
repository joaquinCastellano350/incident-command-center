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
