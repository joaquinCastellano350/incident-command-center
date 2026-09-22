import {
  createPostgresHealthJobWorker,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';

import { loadWorkerConfig } from './config.js';

const config = loadWorkerConfig();
const clock = new SystemClock();
const worker = createPostgresHealthJobWorker({
  connectionString: config.DATABASE_URL,
  clock,
});
const triageWorker = createPostgresTriageWorker({
  connectionString: config.DATABASE_URL,
});

await worker.start();
await triageWorker.start();

const shutdown = async (): Promise<void> => {
  await triageWorker.stop();
  await worker.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
