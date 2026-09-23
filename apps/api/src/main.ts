import {
  createPostgresHealthSystem,
  createPostgresTriageSystem,
} from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';

import { buildApi } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig();
const clock = new SystemClock();
const healthSystem = createPostgresHealthSystem({
  connectionString: config.DATABASE_URL,
  clock,
});
const triageSystem = createPostgresTriageSystem({
  connectionString: config.DATABASE_URL,
  clock,
});

await healthSystem.start();
await triageSystem.start();
const app = await buildApi({
  healthSystem,
  triageSystem,
  allowedOrigin: config.WEB_ORIGIN,
  operatorKey: config.OPERATOR_KEY,
  publicReadOnly: config.PUBLIC_DEMO_READ_ONLY === 'true',
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await triageSystem.stop();
  await healthSystem.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
