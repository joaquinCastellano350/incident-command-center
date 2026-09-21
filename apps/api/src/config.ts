import { z } from 'zod';

const ApiConfigSchema = z.object({
  DATABASE_URL: z.url().startsWith('postgres'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  return ApiConfigSchema.parse(environment);
}
