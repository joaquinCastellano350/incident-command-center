import { createPostgresHealthSystem } from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';

import { buildApi } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig();
const clock = new SystemClock();
const healthSystem = createPostgresHealthSystem({
  connectionString: config.DATABASE_URL,
  clock,
});

await healthSystem.start();
const app = await buildApi({
  healthSystem,
  allowedOrigin: config.WEB_ORIGIN,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await healthSystem.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
