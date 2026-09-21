import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import type { HealthSystem } from '@incident-command-center/application';
import {
  HealthCheckJobSchema,
  HealthStatusSchema,
} from '@incident-command-center/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

interface BuildApiDependencies {
  healthSystem: HealthSystem;
  allowedOrigin: string;
  logger?: boolean;
}

const JobParametersSchema = z.object({ id: z.uuid() });

export async function buildApi({
  healthSystem,
  allowedOrigin,
  logger = true,
}: BuildApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    requestIdHeader: 'x-correlation-id',
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
    const correlationHeader = request.headers['x-correlation-id'];
    const parsedCorrelationId = z
      .uuid()
      .safeParse(
        Array.isArray(correlationHeader)
          ? correlationHeader[0]
          : correlationHeader,
      );
    const correlationId = parsedCorrelationId.success
      ? parsedCorrelationId.data
      : randomUUID();
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

  return app;
}
