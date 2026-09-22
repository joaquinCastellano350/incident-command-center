import {
  createPostgresHealthJobWorker,
  createPostgresTriageWorker,
  JevOperationalJudgmentProvider,
  LiveJevTransport,
  RecordedJevTransport,
} from '@incident-command-center/adapters';
import { SystemClock } from '@incident-command-center/domain';
import { readFile } from 'node:fs/promises';

import { loadWorkerConfig } from './config.js';

const config = loadWorkerConfig();
const clock = new SystemClock();
const worker = createPostgresHealthJobWorker({
  connectionString: config.DATABASE_URL,
  clock,
});
const judgmentProvider =
  config.EVALUATION_MODE === 'live'
    ? new JevOperationalJudgmentProvider(
        new LiveJevTransport(config.TYPESAFE_API_KEY!),
        'live',
        config.JEV_MODEL,
      )
    : new JevOperationalJudgmentProvider(
        new RecordedJevTransport(
          JSON.parse(await readFile(config.RECORDED_JEV_RESPONSE_FILE, 'utf8')),
        ),
        'recorded',
        config.JEV_MODEL,
      );
const triageWorker = createPostgresTriageWorker({
  connectionString: config.DATABASE_URL,
  judgmentProvider,
});

await worker.start();
await triageWorker.start();

const shutdown = async (): Promise<void> => {
  await triageWorker.stop();
  await worker.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
