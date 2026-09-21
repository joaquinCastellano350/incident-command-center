import { z } from 'zod';

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.url().startsWith('postgres'),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
