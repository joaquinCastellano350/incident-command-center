import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { buildApi } from '../../apps/api/src/app.js';
import {
  buildJevRequest,
  JevOperationalJudgmentProvider,
  RecordedJevTransport,
  createPostgresHealthSystem,
  createPostgresTriageSystem,
  createPostgresTriageWorker,
} from '@incident-command-center/adapters';
import {
  DeploymentEventIngestionResultSchema,
  MonitoringAlertIngestionResultSchema,
  TriageCaseDetailSchema,
} from '@incident-command-center/contracts';
import { ManualClock } from '@incident-command-center/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const expectedSignal = {
  service: `checkout-jev-${randomUUID()}`,
  region: 'us-east',
  metric: 'payment_authorization_failure_rate',
  threshold: 2,
  observedValue: 18,
};

describeWithPostgres(
  'audited Jev Evaluation at the ingestion-to-query seam',
  () => {
    const clock = new ManualClock('2026-09-21T12:04:00.000Z');
    const queueName = `jev-evaluation-${randomUUID()}`;
    const databaseName = `incident_test_${randomUUID().replaceAll('-', '_')}`;
    const adminUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
    adminUrl.pathname = '/postgres';
    const isolatedUrl = new URL(databaseUrl ?? 'postgres://localhost/postgres');
    isolatedUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminUrl.toString() });
    let healthSystem: ReturnType<typeof createPostgresHealthSystem>;
    let triageSystem: ReturnType<typeof createPostgresTriageSystem>;
    let api: Awaited<ReturnType<typeof buildApi>>;

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      healthSystem = createPostgresHealthSystem({
        connectionString: isolatedUrl.toString(),
        clock,
        queueName: `health-${randomUUID()}`,
      });
      triageSystem = createPostgresTriageSystem({
        connectionString: isolatedUrl.toString(),
        clock,
        queueName,
      });
      await healthSystem.start();
      await triageSystem.start();
      api = await buildApi({
        healthSystem,
        triageSystem,
        allowedOrigin: 'http://localhost:3000',
        logger: false,
        operatorKey: 'test-operator-key',
      });
    });

    afterAll(async () => {
      await api?.close();
      await triageSystem?.stop();
      await healthSystem?.stop();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end();
    });

    beforeEach(async () => {
      const pool = new Pool({ connectionString: isolatedUrl.toString() });
      try {
        await pool.query('TRUNCATE signals CASCADE');
      } finally {
        await pool.end();
      }
    });

    async function submitAlert(signalFacts = expectedSignal) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/monitoring-alerts',
        payload: {
          provider: 'northstar-monitoring',
          sourceEventKey: randomUUID(),
          sourceReference: 'mon-checkout-authorization-failures',
          ...signalFacts,
          occurredAt: '2026-09-21T12:04:00.000Z',
          evaluationWindowSeconds: 600,
        },
      });
      expect(response.statusCode).toBe(202);
      return MonitoringAlertIngestionResultSchema.parse(response.json());
    }

    async function detail(id: string) {
      const response = await api.inject({
        method: 'GET',
        url: `/api/v1/triage-cases/${id}`,
      });
      expect(response.statusCode).toBe(200);
      return TriageCaseDetailSchema.parse(response.json());
    }

    it('persists a recorded typed response with its probabilities and audit metadata', async () => {
      const recording = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      const accepted = await submitAlert();
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            body: recording[0].body,
            requestId: 'recorded:canonical-p1-v1',
            expectedCorroboratingKinds: ['threshold_breach'],
            expectedSignal: {
              sourceType: 'monitoring_alert',
              service: expectedSignal.service,
              region: expectedSignal.region,
              facts: {
                metric: expectedSignal.metric,
                threshold: expectedSignal.threshold,
                observedValue: expectedSignal.observedValue,
              },
            },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          configuredModel: 'jev-1.13.0',
          resolvedModel: 'jev-1.13.0',
          providerRequestId: 'recorded:canonical-p1-v1',
          inputTokens: 512,
          outputTokens: 96,
          retryCount: 0,
          decisionSchemaVersion: 'operational-judgments.v1',
          questionSetVersion: 'northstar-triage.v1',
          judgments: {
            priorityAssessment: { choice: 'P1' },
            evidenceSufficiency: { yesProbability: 0.99 },
          },
        });
        expect(
          result.evaluation?.judgments?.primaryOwningDomain.probabilities,
        ).toHaveLength(5);
        expect(result.evaluation?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.incidentId).not.toBeNull();
      } finally {
        await worker.stop();
      }
    });

    it('records invalid responses as failed Evaluations and creates a Review Task', async () => {
      const invalidSignal = {
        ...expectedSignal,
        service: `invalid-jev-${randomUUID()}`,
      };
      const accepted = await submitAlert(invalidSignal);
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            body: {
              model: 'jev-1.13.0',
              answers: {},
              usage: { input_tokens: 12, output_tokens: 2 },
            },
            requestId: 'recorded:invalid',
            expectedCorroboratingKinds: ['threshold_breach'],
            expectedSignal: {
              sourceType: 'monitoring_alert',
              service: invalidSignal.service,
              region: invalidSignal.region,
              facts: {
                metric: invalidSignal.metric,
                threshold: invalidSignal.threshold,
                observedValue: invalidSignal.observedValue,
              },
            },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('failed');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          status: 'failed',
          providerRequestId: 'recorded:invalid',
          inputTokens: 12,
          outputTokens: 2,
          failure: { kind: 'invalid_response' },
          judgments: null,
          incidentMatches: [],
        });
        expect(result.triageCase.status).toBe('needs_review');
        expect(result.reviewTask).toMatchObject({ urgency: 'urgent' });
        expect(result.policyDecision).toBeNull();
        expect(result.workflowActions).toEqual([]);
      } finally {
        await worker.stop();
      }
    });

    it('allows an Operator to append a linked Re-evaluation with new evidence', async () => {
      const accepted = await submitAlert({
        ...expectedSignal,
        service: `reevaluate-jev-${randomUUID()}`,
      });
      let attempts = 0;
      const transport = {
        async send() {
          attempts++;
          if (attempts <= 3)
            return { status: 503, body: {}, requestId: `outage-${attempts}` };
          const recording = JSON.parse(
            await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
          );
          return {
            status: 200,
            body: recording[0].body,
            requestId: 'recovered-1',
          };
        },
      };
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(transport, 'live'),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('failed');
        const failed = await detail(accepted.triageCase.id);
        expect(failed.evaluation?.attempts).toHaveLength(3);
        expect(failed.policyDecision).toBeNull();
        expect(failed.workflowActions).toEqual([]);
        const command = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'New signal evidence',
            additionalEvidence: 'Payment failures confirmed by another region.',
          },
        });
        expect(command.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(2);
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          status: 'succeeded',
          previousEvaluationId: failed.evaluation?.id,
        });
        expect(result.evaluationHistory[0]).toEqual(failed.evaluation);
        expect(result.policyDecision?.evaluationId).toBe(result.evaluation?.id);
      } finally {
        await worker.stop();
      }
    });

    it('keeps prior Incident and Workflow Actions when a later Evaluation succeeds', async () => {
      const accepted = await submitAlert({
        ...expectedSignal,
        service: `repeat-jev-${randomUUID()}`,
      });
      const recording = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      const requests: Array<ReturnType<typeof buildJevRequest>> = [];
      const transport = {
        async send(request: ReturnType<typeof buildJevRequest>) {
          requests.push(request);
          const body = structuredClone(recording[0].body);
          body.model = request.model;
          if (request.state.candidates.length > 0) {
            body.answers.incidentMatch_0 = {
              type: 'choice',
              choice: 'same_incident',
              confidence: 0.99,
              probabilities: {
                same_incident: 0.99,
                related_distinct: 0.005,
                unrelated: 0.005,
              },
            };
          }
          return { status: 200, body, requestId: randomUUID() };
        },
      };
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(transport, 'live'),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).workflowActions.find(
                (action) => action.type === 'page_on_call',
              )?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const original = await detail(accepted.triageCase.id);
        const command = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Corroborating customer evidence',
            additionalEvidence:
              'Customers in eu-west now report the same failures.',
          },
        });
        expect(command.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(2);
        const later = await detail(accepted.triageCase.id);
        expect(later.evaluationHistory[0]).toEqual(original.evaluation);
        expect(later.policyDecisionHistory[0]).toEqual(original.policyDecision);
        expect(later.incidentId).toBe(original.incidentId);
        expect(later.workflowActions.map((action) => action.id)).toEqual(
          original.workflowActions.map((action) => action.id),
        );
        expect(later.policyDecision?.supersedesPolicyDecisionId).toBe(
          original.policyDecision?.id,
        );
        const versionCommand = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Pinned model upgrade',
            modelVersion: 'jev-1.14.0',
          },
        });
        expect(versionCommand.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(3);
        const upgraded = await detail(accepted.triageCase.id);
        expect(upgraded.evaluation).toMatchObject({
          previousEvaluationId: later.evaluation?.id,
          configuredModel: 'jev-1.14.0',
          resolvedModel: 'jev-1.14.0',
        });
        expect(upgraded.workflowActions.map((action) => action.id)).toEqual(
          original.workflowActions.map((action) => action.id),
        );
        const policyUpgrade = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Use revised questions and policy',
            questionSetVersion: 'northstar-triage.v2',
            policyVersion: 'northstar-automation.v2',
          },
        });
        expect(policyUpgrade.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(4);
        const revised = await detail(accepted.triageCase.id);
        expect(revised.evaluation).toMatchObject({
          previousEvaluationId: upgraded.evaluation?.id,
          configuredModel: 'jev-1.14.0',
          questionSetVersion: 'northstar-triage.v2',
          policyVersion: 'northstar-automation.v2',
        });
        expect(revised.policyDecision).toMatchObject({
          version: 'northstar-automation.v2',
          thresholds: { evidenceSufficiencyYesProbability: 0.98 },
        });
        expect(requests.at(-1)?.questions.priorityAssessment).toMatchObject({
          instructions: expect.stringContaining('additionalEvidence'),
        });
        const olderModel = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Old model',
            modelVersion: 'jev-1.13.0',
          },
        });
        expect(olderModel.statusCode).toBe(409);
        const olderQuestionSet = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Old questions',
            questionSetVersion: 'northstar-triage.v1',
          },
        });
        expect(olderQuestionSet.statusCode).toBe(409);
        const olderPolicy = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Old policy',
            policyVersion: 'northstar-automation.v1',
          },
        });
        expect(olderPolicy.statusCode).toBe(409);
      } finally {
        await worker.stop();
      }
    });

    it('routes a changed owning Domain to review without repeating prior actions', async () => {
      const accepted = await submitAlert({
        ...expectedSignal,
        service: `changed-owner-${randomUUID()}`,
      });
      const recording = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      let calls = 0;
      const transport = {
        async send(request: ReturnType<typeof buildJevRequest>) {
          calls++;
          if (calls === 3) {
            return {
              status: 200,
              body: { model: request.model, answers: {}, usage: {} },
              requestId: randomUUID(),
            };
          }
          const body = structuredClone(recording[0].body);
          if (calls > 1) {
            body.answers.primaryOwningDomain = {
              type: 'choice',
              choice: 'authentication',
              confidence: 0.99,
              probabilities: {
                payments: 0.0025,
                authentication: 0.99,
                fulfillment: 0.0025,
                platform: 0.0025,
                unknown: 0.0025,
              },
            };
            if (request.state.candidates.length > 0) {
              body.answers.incidentMatch_0 = {
                type: 'choice',
                choice: 'same_incident',
                confidence: 0.99,
                probabilities: {
                  same_incident: 0.99,
                  related_distinct: 0.005,
                  unrelated: 0.005,
                },
              };
            }
          }
          return { status: 200, body, requestId: randomUUID() };
        },
      };
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(transport, 'live'),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).workflowActions.find(
                (action) => action.type === 'page_on_call',
              )?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const original = await detail(accepted.triageCase.id);
        const command = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'New authentication evidence',
            additionalEvidence: 'Authentication failures were confirmed.',
          },
        });
        expect(command.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(2);
        const later = await detail(accepted.triageCase.id);
        expect(later.incidentId).toBe(original.incidentId);
        expect(later.workflowActions.map((action) => action.id)).toEqual(
          original.workflowActions.map((action) => action.id),
        );
        expect(later.policyDecision?.authorizedActions).toEqual([]);
        expect(later.reviewTask).toMatchObject({
          reason: expect.stringContaining(
            'conflicts with the existing assignment',
          ),
        });
        const resolution = await api.inject({
          method: 'POST',
          url: `/api/v1/review-tasks/${accepted.triageCase.id}/resolve`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Authentication is now the responsible Domain',
            resolution: {
              type: 'assign_owner',
              owningDomain: 'authentication',
            },
          },
        });
        expect(resolution.statusCode).toBe(200);
        expect(resolution.json()).toMatchObject({
          reviewTask: { resolvedAt: expect.any(String) },
          humanOverrides: [
            {
              replacementOutcome: {
                type: 'assign_owner',
                owningDomain: 'authentication',
              },
            },
          ],
        });
        const incidentResponse = await api.inject({
          method: 'GET',
          url: `/api/v1/incidents/${original.incidentId}`,
        });
        expect(incidentResponse.json().incident.primaryOwningDomain).toBe(
          'authentication',
        );
        const failedCommand = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Check additional evidence',
            additionalEvidence: 'A later signal needs assessment.',
          },
        });
        expect(failedCommand.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluationHistory.length,
            { timeout: 15_000 },
          )
          .toBe(3);
        const failed = await detail(accepted.triageCase.id);
        expect(failed.evaluation?.status).toBe('failed');
        expect(failed.reviewTask?.resolvedAt).toBeNull();
        const acceptedIncident = await api.inject({
          method: 'POST',
          url: `/api/v1/review-tasks/${accepted.triageCase.id}/resolve`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Current Incident and owner remain correct',
            resolution: { type: 'accept_incident' },
          },
        });
        expect(acceptedIncident.statusCode).toBe(200);
        expect(acceptedIncident.json()).toMatchObject({
          incidentId: original.incidentId,
          reviewTask: { resolvedAt: expect.any(String) },
        });
        expect(
          acceptedIncident
            .json()
            .humanOverrides.map(
              (override: { replacementOutcome: { type: string } }) =>
                override.replacementOutcome.type,
            ),
        ).toEqual(['accept_incident', 'assign_owner']);
      } finally {
        await worker.stop();
      }
    });

    it('a later Policy Decision can authorize a new page using Current Priority', async () => {
      const accepted = await submitAlert({
        ...expectedSignal,
        service: `later-page-${randomUUID()}`,
      });
      const recording = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      let calls = 0;
      const transport = {
        async send(request: ReturnType<typeof buildJevRequest>) {
          calls++;
          const body = structuredClone(recording[0].body);
          if (calls === 1) {
            body.answers.priorityAssessment = {
              type: 'choice',
              choice: 'P2',
              confidence: 0.98,
              probabilities: { P0: 0.005, P1: 0.01, P2: 0.98, P3: 0.005 },
            };
          } else if (request.state.candidates.length) {
            body.answers.incidentMatch_0 = {
              type: 'choice',
              choice: 'same_incident',
              confidence: 0.99,
              probabilities: {
                same_incident: 0.99,
                related_distinct: 0.005,
                unrelated: 0.005,
              },
            };
          }
          return { status: 200, body, requestId: randomUUID() };
        },
      };
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(transport, 'live'),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).workflowActions.find(
                (action) => action.type === 'assign_owner',
              )?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const original = await detail(accepted.triageCase.id);
        expect(
          original.workflowActions.some(
            (action) => action.type === 'page_on_call',
          ),
        ).toBe(false);
        const override = await api.inject({
          method: 'POST',
          url: `/api/v1/incidents/${original.incidentId}/priority-override`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'Impact now major',
            priority: 'P1',
          },
        });
        expect(override.statusCode).toBe(200);
        const command = await api.inject({
          method: 'POST',
          url: `/api/v1/triage-cases/${accepted.triageCase.id}/reevaluations`,
          headers: { 'x-operator-key': 'test-operator-key' },
          payload: {
            actor: 'demo-operator',
            reason: 'New regional evidence',
            additionalEvidence: 'Additional regional failures confirmed.',
          },
        });
        expect(command.statusCode).toBe(202);
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).workflowActions.find(
                (action) => action.type === 'page_on_call',
              )?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const later = await detail(accepted.triageCase.id);
        expect(later.incidentId).toBe(original.incidentId);
        expect(later.policyDecision?.authorizedActions).toContain(
          'page_on_call',
        );
        expect(
          later.workflowActions.filter(
            (action) => action.type === 'create_incident',
          ),
        ).toHaveLength(1);
        expect(
          later.workflowActions.filter(
            (action) => action.type === 'page_on_call',
          ),
        ).toHaveLength(1);
      } finally {
        await worker.stop();
      }
    });

    it('evaluates a Deployment Event without creating an Incident', async () => {
      const service = `deployment-jev-${randomUUID()}`;
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/signals/deployment-events',
        payload: {
          provider: 'northstar-deployments',
          sourceEventKey: randomUUID(),
          sourceReference: 'deploy-checkout-2026-09-20-3',
          service,
          region: 'us-east',
          version: '2026.09.20.3',
          commitReference: 'a91ce0f',
          deployer: 'release-bot',
          outcome: 'succeeded',
          occurredAt: '2026-09-21T12:00:00.000Z',
        },
      });
      const accepted = DeploymentEventIngestionResultSchema.parse(
        response.json(),
      );
      const recordings = JSON.parse(
        await readFile('apps/worker/recordings/canonical-p1.json', 'utf8'),
      );
      const deployment = recordings[1];
      const worker = createPostgresTriageWorker({
        connectionString: isolatedUrl.toString(),
        queueName,
        clock,
        judgmentProvider: new JevOperationalJudgmentProvider(
          new RecordedJevTransport({
            ...deployment,
            expectedSignal: { ...deployment.expectedSignal, service },
          }),
          'recorded',
        ),
      });
      await worker.start();
      try {
        await expect
          .poll(
            async () =>
              (await detail(accepted.triageCase.id)).evaluation?.status,
            { timeout: 15_000 },
          )
          .toBe('succeeded');
        const result = await detail(accepted.triageCase.id);
        expect(result.evaluation).toMatchObject({
          mode: 'recorded',
          judgments: { priorityAssessment: { choice: 'P3' } },
        });
        expect(result.incidentId).toBeNull();
        expect(result.workflowActions).toEqual([]);
        expect(result.reviewTask).toMatchObject({ urgency: 'standard' });
      } finally {
        await worker.stop();
      }
    });
  },
);
