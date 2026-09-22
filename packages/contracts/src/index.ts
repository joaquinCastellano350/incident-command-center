import { z } from 'zod';

export const ComponentStatusSchema = z.enum(['ready', 'unavailable']);

export const HealthStatusSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  api: z.literal('ready'),
  database: ComponentStatusSchema,
  worker: ComponentStatusSchema,
  checkedAt: z.iso.datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthCheckResultSchema = z.object({
  message: z.string(),
  queue: z.string(),
});

export const HealthCheckJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'completed']),
  correlationId: z.uuid(),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  result: HealthCheckResultSchema.nullable(),
});

export type HealthCheckJob = z.infer<typeof HealthCheckJobSchema>;

export const HealthCheckMessageV1Schema = z.object({
  version: z.literal(1),
  healthJobId: z.uuid(),
  correlationId: z.uuid(),
});

export type HealthCheckMessageV1 = z.infer<typeof HealthCheckMessageV1Schema>;

export const MonitoringAlertInputSchema = z
  .object({
    provider: z.string().trim().min(1),
    sourceEventKey: z.string().trim().min(1),
    sourceReference: z.string().trim().min(1),
    metric: z.string().trim().min(1),
    threshold: z.number().finite(),
    observedValue: z.number().finite(),
    service: z.string().trim().min(1),
    region: z.enum(['us-east', 'eu-west', 'sa-east']),
    occurredAt: z.iso.datetime(),
    evaluationWindowSeconds: z.number().int().positive(),
    environment: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    rawFixtureReference: z.string().trim().min(1).optional(),
  })
  .strict();

export type MonitoringAlertInput = z.infer<typeof MonitoringAlertInputSchema>;

export const DeploymentEventInputSchema = z
  .object({
    provider: z.string().trim().min(1),
    sourceEventKey: z.string().trim().min(1),
    sourceReference: z.string().trim().min(1),
    service: z.string().trim().min(1),
    region: z.enum(['us-east', 'eu-west', 'sa-east']),
    version: z.string().trim().min(1),
    commitReference: z.string().trim().min(1),
    deployer: z.string().trim().min(1),
    outcome: z.enum(['succeeded', 'failed', 'rolled_back']),
    occurredAt: z.iso.datetime(),
    environment: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    rawFixtureReference: z.string().trim().min(1).optional(),
  })
  .strict();

export type DeploymentEventInput = z.infer<typeof DeploymentEventInputSchema>;

export const MonitoringAlertFactsSchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  observedValue: z.number(),
  evaluationWindowSeconds: z.number().int().positive(),
});

export const DeploymentEventFactsSchema = z.object({
  version: z.string(),
  commitReference: z.string(),
  deployer: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'rolled_back']),
});

const SignalEnvelopeSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  sourceEventKey: z.string(),
  sourceReference: z.string(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  service: z.string(),
  environment: z.string().nullable(),
  region: z.string().nullable(),
  title: z.string().nullable(),
  content: z.string().nullable(),
  normalizationVersion: z.literal(1),
  rawFixtureReference: z.string().nullable(),
  correlationId: z.uuid(),
});

export const MonitoringAlertSignalSchema = SignalEnvelopeSchema.extend({
  sourceType: z.literal('monitoring_alert'),
  facts: MonitoringAlertFactsSchema,
});

export const DeploymentEventSignalSchema = SignalEnvelopeSchema.extend({
  sourceType: z.literal('deployment_event'),
  facts: DeploymentEventFactsSchema,
});

export const SignalSchema = z.discriminatedUnion('sourceType', [
  MonitoringAlertSignalSchema,
  DeploymentEventSignalSchema,
]);

export type Signal = z.infer<typeof SignalSchema>;

export const TriageCaseStatusSchema = z.enum([
  'queued',
  'ready_for_evaluation',
  'incident_created',
  'needs_review',
]);

export const TriageCaseSchema = z.object({
  id: z.uuid(),
  signalId: z.uuid(),
  status: TriageCaseStatusSchema,
  sourceReference: z.string(),
  service: z.string(),
  region: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  correlationId: z.uuid(),
});

export type TriageCase = z.infer<typeof TriageCaseSchema>;

export const MonitoringAlertIngestionResultSchema = z.object({
  signal: MonitoringAlertSignalSchema,
  triageCase: TriageCaseSchema,
  deduplicated: z.boolean(),
});

export type MonitoringAlertIngestionResult = z.infer<
  typeof MonitoringAlertIngestionResultSchema
>;

export const DeploymentEventIngestionResultSchema = z.object({
  signal: DeploymentEventSignalSchema,
  triageCase: TriageCaseSchema,
  deduplicated: z.boolean(),
});

export type DeploymentEventIngestionResult = z.infer<
  typeof DeploymentEventIngestionResultSchema
>;

const probability = z.number().min(0).max(1);

function choiceJudgmentSchema<
  const TValues extends readonly [string, ...string[]],
>(values: TValues) {
  const outcome = z.enum(values);
  return z
    .object({
      choice: outcome,
      confidence: probability.optional(),
      probabilities: z
        .array(z.object({ outcome, probability }))
        .length(values.length),
    })
    .superRefine((judgment, context) => {
      const outcomes = new Set(
        judgment.probabilities.map((item) => item.outcome),
      );
      const total = judgment.probabilities.reduce(
        (sum, item) => sum + item.probability,
        0,
      );
      if (
        outcomes.size !== values.length ||
        values.some((value) => !outcomes.has(value)) ||
        Math.abs(total - 1) > 0.02
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Choice requires a complete probability distribution',
        });
      }
      const selected =
        judgment.probabilities.find((item) => item.outcome === judgment.choice)
          ?.probability ?? 0;
      if (
        judgment.probabilities.some(
          (item) => item.probability > selected + 0.0001,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Choice must have the highest probability',
        });
      }
    });
}

export const IncidentMatchSchema = choiceJudgmentSchema([
  'same_incident',
  'related_distinct',
  'unrelated',
]);

export const CandidateIncidentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  service: z.string(),
  region: z.string().nullable(),
  status: z.enum(['open', 'acknowledged', 'mitigated', 'resolved']),
  resolvedAt: z.iso.datetime().nullable().default(null),
  currentPriority: z.enum(['P0', 'P1', 'P2', 'P3']),
  primaryOwningDomain: z.enum([
    'payments',
    'authentication',
    'fulfillment',
    'platform',
    'unknown',
  ]),
});
export type CandidateIncident = z.infer<typeof CandidateIncidentSchema>;

export const EvaluationInputSchema = z.object({
  signal: SignalSchema,
  corroboratingFacts: z.array(
    z.object({
      kind: z.string(),
      summary: z.string(),
      evidenceSignalIds: z.array(z.uuid()),
    }),
  ),
  candidates: z.array(CandidateIncidentSchema).max(5),
});
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;

export const OperationalJudgmentsSchema = z.object({
  priorityAssessment: choiceJudgmentSchema(['P0', 'P1', 'P2', 'P3']),
  customerReach: choiceJudgmentSchema([
    'single',
    'subset',
    'widespread',
    'unknown',
  ]),
  regionalReach: choiceJudgmentSchema([
    'single_region',
    'multi_region',
    'global',
    'not_applicable',
    'unknown',
  ]),
  serviceBreadth: choiceJudgmentSchema([
    'single_service',
    'multi_service',
    'platform_wide',
    'unknown',
  ]),
  primaryOwningDomain: choiceJudgmentSchema([
    'payments',
    'authentication',
    'fulfillment',
    'platform',
    'unknown',
  ]),
  evidenceSufficiency: z.object({ yesProbability: probability }),
});

export type OperationalJudgments = z.infer<typeof OperationalJudgmentsSchema>;

export const EvaluationSchema = z
  .object({
    id: z.uuid(),
    triageCaseId: z.uuid(),
    previousEvaluationId: z.uuid().nullable(),
    correlationId: z.uuid(),
    status: z.enum(['succeeded', 'failed']),
    mode: z
      .enum(['live', 'recorded', 'deterministic'])
      .default('deterministic'),
    configuredModel: z.string().min(1),
    resolvedModel: z.string().min(1),
    normalizationVersion: z.literal(1),
    decisionSchemaVersion: z.literal('operational-judgments.v1'),
    questionSetVersion: z.literal('northstar-triage.v1'),
    policyVersion: z.literal('northstar-automation.v1'),
    attemptId: z.uuid(),
    providerRequestId: z.string().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    evaluatedAt: z.iso.datetime(),
    judgments: OperationalJudgmentsSchema.nullable(),
    incidentMatches: z
      .array(
        z.object({
          candidateIncidentId: z.uuid(),
          judgment: IncidentMatchSchema,
        }),
      )
      .default([]),
    failure: z
      .object({
        kind: z.enum(['deadline', 'provider', 'invalid_response']),
        message: z.string(),
      })
      .nullable()
      .default(null),
  })
  .superRefine((evaluation, context) => {
    if (
      evaluation.status === 'succeeded' &&
      (!evaluation.judgments || evaluation.failure)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Successful Evaluation requires judgments and no failure',
      });
    }
    if (
      evaluation.status === 'failed' &&
      (evaluation.judgments || !evaluation.failure)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed Evaluation requires a failure and no judgments',
      });
    }
  });

export type Evaluation = z.infer<typeof EvaluationSchema>;

export const ReviewTaskSchema = z.object({
  id: z.uuid(),
  triageCaseId: z.uuid(),
  correlationId: z.uuid(),
  urgency: z.enum(['urgent', 'standard']),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

export const CorroboratingFactSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['threshold_breach', 'recent_deployment']),
  summary: z.string(),
  evidenceSignalIds: z.array(z.uuid()).min(1),
});

export type CorroboratingFact = z.infer<typeof CorroboratingFactSchema>;

export const WorkflowActionTypeSchema = z.enum([
  'create_incident',
  'assign_owner',
  'page_on_call',
]);

export type WorkflowActionType = z.infer<typeof WorkflowActionTypeSchema>;

export const PolicyRuleResultSchema = z.object({
  ruleId: z.string(),
  action: WorkflowActionTypeSchema,
  outcome: z.enum(['authorized', 'denied']),
  explanation: z.string(),
});

export type PolicyRuleResult = z.infer<typeof PolicyRuleResultSchema>;

export const PolicyDecisionSchema = z.object({
  id: z.uuid(),
  triageCaseId: z.uuid(),
  evaluationId: z.uuid(),
  supersedesPolicyDecisionId: z.uuid().nullable(),
  correlationId: z.uuid(),
  version: z.literal('northstar-automation.v1'),
  thresholds: z.object({
    priorityChoiceProbability: probability,
    impactChoiceProbability: probability,
    ownershipChoiceProbability: probability,
    evidenceSufficiencyYesProbability: probability,
  }),
  rules: z.array(PolicyRuleResultSchema),
  authorizedActions: z.array(WorkflowActionTypeSchema),
  decidedAt: z.iso.datetime(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ActionAttemptSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  attemptedAt: z.iso.datetime(),
  outcome: z.enum([
    'started',
    'succeeded',
    'transient_failure',
    'permanent_failure',
    'interrupted',
    'suppressed',
  ]),
  providerReference: z.string().nullable(),
  detail: z.string().nullable(),
});

export type ActionAttempt = z.infer<typeof ActionAttemptSchema>;

export const WorkflowActionSchema = z.object({
  id: z.uuid(),
  correlationId: z.uuid(),
  policyDecisionId: z.uuid(),
  type: WorkflowActionTypeSchema,
  targetOwningDomain: z
    .enum(['payments', 'authentication', 'fulfillment', 'platform'])
    .nullable(),
  status: z.enum([
    'pending',
    'executing',
    'retry_scheduled',
    'succeeded',
    'permanently_failed',
  ]),
  idempotencyKey: z.string(),
  providerReference: z.string().nullable(),
  nextRetryAt: z.iso.datetime().nullable(),
  maxAttempts: z.number().int().positive(),
  suppressedCount: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  attempts: z.array(ActionAttemptSchema),
});

export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;

export const IncidentSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    status: z.enum(['open', 'acknowledged', 'mitigated', 'resolved']),
    resolvedAt: z.iso.datetime().nullable().default(null),
    currentPriority: z.enum(['P0', 'P1', 'P2', 'P3']),
    primaryOwningDomain: z.enum([
      'payments',
      'authentication',
      'fulfillment',
      'platform',
      'unknown',
    ]),
    createdAt: z.iso.datetime(),
    correlationId: z.uuid(),
  })
  .refine(
    (incident) => incident.status !== 'resolved' || !!incident.resolvedAt,
    {
      message: 'Resolved Incidents require resolvedAt',
      path: ['resolvedAt'],
    },
  );

export type Incident = z.infer<typeof IncidentSchema>;

export const TimelineEventSchema = z.object({
  id: z.uuid(),
  correlationId: z.uuid(),
  type: z.enum(['incident_created', 'owner_assigned', 'on_call_paged']),
  occurredAt: z.iso.datetime(),
  summary: z.string(),
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TriageCaseDetailSchema = z.object({
  triageCase: TriageCaseSchema,
  signal: SignalSchema,
  evaluation: EvaluationSchema.nullable(),
  reviewTask: ReviewTaskSchema.nullable(),
  corroboratingFacts: z.array(CorroboratingFactSchema),
  policyDecision: PolicyDecisionSchema.nullable(),
  workflowActions: z.array(WorkflowActionSchema),
  timelineEvents: z.array(TimelineEventSchema),
  incidentId: z.uuid().nullable(),
});

export type TriageCaseDetail = z.infer<typeof TriageCaseDetailSchema>;

export const IncidentDetailSchema = z.object({
  incident: IncidentSchema,
  signal: SignalSchema,
  evaluation: EvaluationSchema,
  reviewTask: ReviewTaskSchema.nullable(),
  corroboratingFacts: z.array(CorroboratingFactSchema),
  policyDecision: PolicyDecisionSchema,
  workflowActions: z.array(WorkflowActionSchema),
  timelineEvents: z.array(TimelineEventSchema),
});

export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;

export const PageRequestSchema = z.object({
  incidentId: z.uuid(),
  correlationId: z.uuid(),
  priority: z.enum(['P0', 'P1']),
  owningDomain: z.enum([
    'payments',
    'authentication',
    'fulfillment',
    'platform',
  ]),
  summary: z.string(),
  idempotencyKey: z.string(),
});

export type PageRequest = z.infer<typeof PageRequestSchema>;

export const AssignmentRequestSchema = z.object({
  incidentId: z.uuid(),
  correlationId: z.uuid(),
  owningDomain: z.enum([
    'payments',
    'authentication',
    'fulfillment',
    'platform',
  ]),
  idempotencyKey: z.string(),
});

export type AssignmentRequest = z.infer<typeof AssignmentRequestSchema>;

export const WorkflowActionJobMessageV1Schema = z.object({
  version: z.literal(1),
  actionId: z.uuid(),
  correlationId: z.uuid(),
});

export type WorkflowActionJobMessageV1 = z.infer<
  typeof WorkflowActionJobMessageV1Schema
>;

export const TriageQueueSchema = z.object({
  items: z.array(TriageCaseSchema),
});

export type TriageQueue = z.infer<typeof TriageQueueSchema>;

export const TriageJobMessageV1Schema = z.object({
  version: z.literal(1),
  triageCaseId: z.uuid(),
  signalId: z.uuid(),
  correlationId: z.uuid(),
});

export type TriageJobMessageV1 = z.infer<typeof TriageJobMessageV1Schema>;
