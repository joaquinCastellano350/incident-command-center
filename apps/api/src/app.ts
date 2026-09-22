import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import type {
  HealthSystem,
  TriageSystem,
} from '@incident-command-center/application';
import {
  HealthCheckJobSchema,
  HealthStatusSchema,
  MonitoringAlertInputSchema,
  MonitoringAlertIngestionResultSchema,
  TriageQueueSchema,
} from '@incident-command-center/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

interface BuildApiDependencies {
  healthSystem: HealthSystem;
  triageSystem?: TriageSystem;
  allowedOrigin: string;
  logger?: boolean;
}

const JobParametersSchema = z.object({ id: z.uuid() });
function requestCorrelationId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  const parsed = z.uuid().safeParse(candidate);
  return parsed.success ? parsed.data : randomUUID();
}

function triageQueueEvent(
  items: Awaited<ReturnType<TriageSystem['listTriageCases']>>,
): string {
  const queue = TriageQueueSchema.parse({ items });
  return `retry: 2000\nevent: triage-queue\ndata: ${JSON.stringify(queue)}\n\n`;
}

export async function buildApi({
  healthSystem,
  triageSystem,
  allowedOrigin,
  logger = true,
}: BuildApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    genReqId: (request) =>
      requestCorrelationId(request.headers['x-correlation-id']),
  });

  await app.register(cors, {
    origin: allowedOrigin,
    methods: ['GET', 'POST'],
  });

  app.get('/api/v1/health', async (_request, reply) => {
    const health = HealthStatusSchema.parse(await healthSystem.readiness());
    return reply.code(health.status === 'ready' ? 200 : 503).send(health);
  });

  app.post('/api/v1/health-jobs', async (request, reply) => {
    const correlationId = z.uuid().parse(request.id);
    const job = HealthCheckJobSchema.parse(
      await healthSystem.submitHealthCheck(correlationId),
    );
    request.log.info(
      { healthJobId: job.id, correlationId },
      'health job queued',
    );
    return reply
      .header('location', `/api/v1/health-jobs/${job.id}`)
      .code(202)
      .send(job);
  });

  app.get('/api/v1/health-jobs/:id', async (request, reply) => {
    const parameters = JobParametersSchema.safeParse(request.params);
    if (!parameters.success) {
      return reply.code(400).send({ error: 'Invalid health job identifier' });
    }

    const job = await healthSystem.findHealthCheck(parameters.data.id);
    if (!job) {
      return reply.code(404).send({ error: 'Health job not found' });
    }

    return reply.send(HealthCheckJobSchema.parse(job));
  });

  if (triageSystem) {
    app.post('/api/v1/signals/monitoring-alerts', async (request, reply) => {
      const input = MonitoringAlertInputSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({
          error: 'Invalid Monitoring Alert',
          issues: input.error.issues,
        });
      }

      const correlationId = z.uuid().parse(request.id);
      const result = MonitoringAlertIngestionResultSchema.parse(
        await triageSystem.ingestMonitoringAlert(input.data, correlationId),
      );

      return reply
        .header('location', `/api/v1/triage-cases/${result.triageCase.id}`)
        .code(result.deduplicated ? 200 : 202)
        .send(result);
    });

    app.get('/api/v1/triage-cases', async (_request, reply) => {
      return reply.send(
        TriageQueueSchema.parse({
          items: await triageSystem.listTriageCases(),
        }),
      );
    });

    app.get('/api/v1/triage-cases/events', async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'access-control-allow-origin': allowedOrigin,
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });

      let previousEvent = '';
      let closed = false;
      const writeLatestQueue = async (): Promise<void> => {
        if (closed || reply.raw.writableEnded) {
          return;
        }
        const event = triageQueueEvent(await triageSystem.listTriageCases());
        if (event !== previousEvent) {
          previousEvent = event;
          reply.raw.write(event);
        }
      };

      await writeLatestQueue();
      const interval = setInterval(() => {
        void writeLatestQueue().catch(() => {
          clearInterval(interval);
          reply.raw.end();
        });
      }, 500);
      interval.unref();

      request.raw.once('close', () => {
        closed = true;
        clearInterval(interval);
      });
    });
  }

  return app;
}
