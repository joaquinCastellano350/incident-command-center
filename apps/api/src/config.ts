import { z } from 'zod';

const ApiConfigSchema = z.object({
  DATABASE_URL: z.url().startsWith('postgres'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  OPERATOR_KEY: z.string().min(1).optional(),
  PUBLIC_DEMO_READ_ONLY: z.enum(['true', 'false']).default('false'),
  ASSISTANT_MODE: z.enum(['live', 'recorded']).default('recorded'),
  ASSISTANT_MODEL: z
    .string()
    .regex(/^gpt-5\.6-terra(?:-|$)/)
    .default('gpt-5.6-terra'),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  return ApiConfigSchema.parse(environment);
}
