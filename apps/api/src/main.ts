import {
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresAssistantSystem,
  LiveOpenAIAssistantProvider,
  RecordedAssistantProvider,
  LIVE_ASSISTANT_CONFIGURATION_VERSION,
  RECORDED_ASSISTANT_CONFIGURATION_VERSION,
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
if (config.ASSISTANT_MODE === 'live' && !config.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for live assistant mode');
}
const assistantSystem = createPostgresAssistantSystem({
  connectionString: config.DATABASE_URL,
  clock,
  mode: config.ASSISTANT_MODE,
  configuredModel:
    config.ASSISTANT_MODE === 'live'
      ? config.ASSISTANT_MODEL
      : 'gpt-5.6-terra-recorded-v1',
  configurationVersion:
    config.ASSISTANT_MODE === 'live'
      ? LIVE_ASSISTANT_CONFIGURATION_VERSION
      : RECORDED_ASSISTANT_CONFIGURATION_VERSION,
  provider:
    config.ASSISTANT_MODE === 'live'
      ? new LiveOpenAIAssistantProvider(config.OPENAI_API_KEY!)
      : new RecordedAssistantProvider(),
});

await healthSystem.start();
await triageSystem.start();
await assistantSystem.start();
const app = await buildApi({
  healthSystem,
  triageSystem,
  assistantSystem,
  allowedOrigin: config.WEB_ORIGIN,
  operatorKey: config.OPERATOR_KEY,
  publicReadOnly: config.PUBLIC_DEMO_READ_ONLY === 'true',
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await triageSystem.stop();
  await assistantSystem.stop();
  await healthSystem.stop();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
