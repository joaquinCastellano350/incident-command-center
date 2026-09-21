import { PgBossHealthJobWorker } from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

import { loadWorkerConfig } from './config.js';

const config = loadWorkerConfig();
const clock = new SystemClock();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const boss = new PgBoss({ connectionString: config.DATABASE_URL });
const worker = new PgBossHealthJobWorker(pool, boss, clock);

await worker.start();

const shutdown = async (): Promise<void> => {
  await worker.stop();
  await pool.end();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
