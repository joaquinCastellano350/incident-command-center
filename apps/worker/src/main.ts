import { createPostgresHealthJobWorker } from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';

import { loadWorkerConfig } from './config.js';

const config = loadWorkerConfig();
const clock = new SystemClock();
const worker = createPostgresHealthJobWorker({
  connectionString: config.DATABASE_URL,
  clock,
});

await worker.start();

const shutdown = async (): Promise<void> => {
  await worker.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
