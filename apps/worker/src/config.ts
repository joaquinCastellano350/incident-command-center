import { z } from 'zod';
import { fileURLToPath } from 'node:url';

const WorkerConfigSchema = z
  .object({
    DATABASE_URL: z.url().startsWith('postgres'),
    EVALUATION_MODE: z.enum(['live', 'recorded']).default('live'),
    TYPESAFE_API_KEY: z.string().optional(),
    JEV_MODEL: z.string().default('jev-1.13.0'),
    RECORDED_JEV_RESPONSE_FILE: z
      .string()
      .default(
        fileURLToPath(
          new URL('../recordings/canonical-p1.json', import.meta.url),
        ),
      ),
  })
  .superRefine((config, context) => {
    if (config.EVALUATION_MODE === 'live' && !config.TYPESAFE_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['TYPESAFE_API_KEY'],
        message: 'Live mode requires a TypeSafe API key',
      });
    }
    if (
      config.EVALUATION_MODE === 'live' &&
      /latest|preview/.test(config.JEV_MODEL)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['JEV_MODEL'],
        message: 'Live mode requires a pinned Jev version',
      });
    }
  });

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
