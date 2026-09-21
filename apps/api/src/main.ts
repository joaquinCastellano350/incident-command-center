import { PostgresHealthSystem } from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

import { buildApi } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig();
const clock = new SystemClock();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const boss = new PgBoss({ connectionString: config.DATABASE_URL });
const healthSystem = new PostgresHealthSystem(pool, boss, clock);

await healthSystem.start();
const app = await buildApi({
  healthSystem,
  clock,
  allowedOrigin: config.WEB_ORIGIN,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await healthSystem.stop();
  await pool.end();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
