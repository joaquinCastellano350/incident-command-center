import { performance } from 'node:perf_hooks';

import {
  EvaluationInputSchema,
  OperationalJudgmentsSchema,
  IncidentMatchSchema,
  type EvaluationInput,
  type OperationalJudgments,
} from '@incident-command-center/contracts';
import {
  NORTHSTAR_SERVICE_DOMAINS,
  type OperationalJudgmentProviderPort,
  type OperationalJudgmentResult,
} from '@incident-command-center/domain';
import { z } from 'zod';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_QUESTION_SET_VERSION = 'northstar-triage.v1';

const question = (instructions: string, criteria: Record<string, string>) => ({
  type: 'choice' as const,
  instructions,
  criteria,
});

export function buildJevRequest(input: EvaluationInput, model = JEV_MODEL) {
  const { signal, corroboratingFacts, candidates } =
    EvaluationInputSchema.parse(input);
  const questions: Record<string, unknown> = {
    priorityAssessment: question(
      'Assess response priority for `signal` using observed impact and urgency.',
      {
        P0: 'Critical cross-team response required.',
        P1: 'Major immediate owning-domain response required.',
        P2: 'Moderate tracked impact without immediate paging.',
        P3: 'Minor or unconfirmed impact.',
      },
    ),
    customerReach: question('How many customers are affected by `signal`?', {
      single: 'One customer.',
      subset: 'A subset of customers.',
      widespread: 'A large share of customers.',
      unknown: 'The evidence does not establish reach.',
    }),
    regionalReach: question('What is the geographic reach of `signal`?', {
      single_region: 'One Northstar Market region.',
      multi_region: 'More than one but not all regions.',
      global: 'All regions.',
      not_applicable: 'Region does not apply.',
      unknown: 'The evidence does not establish regional reach.',
    }),
    serviceBreadth: question('How many Services are affected by `signal`?', {
      single_service: 'One Service.',
      multi_service: 'Several Services.',
      platform_wide: 'Platform-wide capability.',
      unknown: 'The evidence does not establish Service breadth.',
    }),
    primaryOwningDomain: question(
      'Which Northstar Market Domain is the best first owner of the problem described by `signal`? Select unknown when ownership is unclear; platform is a real Domain.',
      {
        payments: 'Payment authorization, checkout payments, or payouts.',
        authentication: 'Identity, login, or sessions.',
        fulfillment: 'Orders and fulfillment.',
        platform: 'Shared infrastructure and platform Services.',
        unknown: 'No Domain has sufficient evidence for ownership.',
      },
    ),
    evidenceSufficiency: {
      type: 'noul',
      instructions:
        'Is the available `signal` and `corroboratingFacts` evidence sufficient to make operational judgments without guessing missing facts?',
      criteria: {
        true: 'Specific observed evidence supports the judgments.',
        false: 'Evidence is vague, missing, or contradictory.',
      },
    },
  };
  for (const [index] of candidates.entries()) {
    questions[`incidentMatch_${index}`] = question(
      `Does \`signal\` describe the same disruption as \`candidates[${index}]\`? Assess their relationship only.`,
      {
        same_incident:
          'The same disruption or an additional observation of it.',
        related_distinct:
          'Related systems or cause, but a distinct disruption.',
        unrelated: 'No meaningful incident relationship.',
      },
    );
  }
  return {
    model,
    state: {
      signal: {
        id: signal.id,
        sourceType: signal.sourceType,
        provider: signal.provider,
        sourceEventKey: signal.sourceEventKey,
        sourceReference: signal.sourceReference,
        occurredAt: signal.occurredAt,
        receivedAt: signal.receivedAt,
        service: signal.service,
        region: signal.region,
        environment: signal.environment,
        title: signal.title,
        content: signal.content,
        facts: signal.facts,
        normalizationVersion: signal.normalizationVersion,
        correlationId: signal.correlationId,
      },
      taxonomy: {
        organization: 'Northstar Market',
        regions: ['us-east', 'eu-west', 'sa-east'],
        domains: ['payments', 'authentication', 'fulfillment', 'platform'],
        serviceDomains: NORTHSTAR_SERVICE_DOMAINS,
      },
      corroboratingFacts,
      candidates,
    },
    questions,
  };
}

const probability = z.number().finite().min(0).max(1);
const choiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability,
});
const noulAnswer = z.object({ type: z.literal('noul'), noul: probability });
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

function normalizeChoice(raw: unknown, outcomes: readonly string[]) {
  const answer = choiceAnswer.parse(raw);
  const keys = Object.keys(answer.probabilities);
  if (
    !outcomes.includes(answer.choice) ||
    keys.length !== outcomes.length ||
    keys.some((key) => !outcomes.includes(key))
  ) {
    throw new Error('Choice options do not match the question');
  }
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: outcomes.map((outcome) => ({
      outcome,
      probability: answer.probabilities[outcome]!,
    })),
  };
}

function normalizeResponse(
  raw: unknown,
  candidates: EvaluationInput['candidates'],
) {
  const response = responseSchema.parse(raw);
  const answers = response.answers;
  const judgments = OperationalJudgmentsSchema.parse({
    priorityAssessment: normalizeChoice(answers.priorityAssessment, [
      'P0',
      'P1',
      'P2',
      'P3',
    ]),
    customerReach: normalizeChoice(answers.customerReach, [
      'single',
      'subset',
      'widespread',
      'unknown',
    ]),
    regionalReach: normalizeChoice(answers.regionalReach, [
      'single_region',
      'multi_region',
      'global',
      'not_applicable',
      'unknown',
    ]),
    serviceBreadth: normalizeChoice(answers.serviceBreadth, [
      'single_service',
      'multi_service',
      'platform_wide',
      'unknown',
    ]),
    primaryOwningDomain: normalizeChoice(answers.primaryOwningDomain, [
      'payments',
      'authentication',
      'fulfillment',
      'platform',
      'unknown',
    ]),
    evidenceSufficiency: {
      yesProbability: noulAnswer.parse(answers.evidenceSufficiency).noul,
    },
  });
  const incidentMatches = candidates.map((candidate, index) => ({
    candidateIncidentId: candidate.id,
    judgment: IncidentMatchSchema.parse(
      normalizeChoice(answers[`incidentMatch_${index}`], [
        'same_incident',
        'related_distinct',
        'unrelated',
      ]),
    ),
  }));
  return { response, judgments, incidentMatches };
}

export interface JevTransport {
  send(
    request: ReturnType<typeof buildJevRequest>,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown; requestId: string | null }>;
}

export class LiveJevTransport implements JevTransport {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.typesafe.ai/v1/systemone',
  ) {}

  async send(request: ReturnType<typeof buildJevRequest>, signal: AbortSignal) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      requestId: response.headers.get('x-typesafe-request-id'),
    };
  }
}

export interface JevRecording {
  body: unknown;
  requestId: string;
  expectedSignal: {
    sourceType: 'monitoring_alert' | 'deployment_event';
    service: string;
    region: string | null;
    facts: Record<string, unknown>;
  };
  expectedCandidateIds?: string[];
  expectedCorroboratingKinds?: string[];
}

export class RecordedJevTransport implements JevTransport {
  private readonly recordings: JevRecording[];

  constructor(recordings: JevRecording | JevRecording[]) {
    this.recordings = Array.isArray(recordings) ? recordings : [recordings];
  }

  async send(
    request: ReturnType<typeof buildJevRequest>,
    _signal: AbortSignal,
  ) {
    const signal = request.state.signal;
    const recording = this.recordings.find(
      ({ expectedSignal, expectedCandidateIds, expectedCorroboratingKinds }) =>
        signal.sourceType === expectedSignal.sourceType &&
        signal.service === expectedSignal.service &&
        signal.region === expectedSignal.region &&
        Object.entries(expectedSignal.facts).every(
          ([key, value]) =>
            JSON.stringify((signal.facts as Record<string, unknown>)[key]) ===
            JSON.stringify(value),
        ) &&
        JSON.stringify(
          request.state.candidates.map((candidate) => candidate.id),
        ) === JSON.stringify(expectedCandidateIds ?? []) &&
        JSON.stringify(
          request.state.corroboratingFacts.map((fact) => fact.kind).sort(),
        ) === JSON.stringify((expectedCorroboratingKinds ?? []).slice().sort()),
    );
    if (!recording)
      return {
        status: 404,
        body: { error: 'No matching recording' },
        requestId: null,
      };
    return {
      status: 200,
      body: recording.body,
      requestId: recording.requestId,
    };
  }
}

export class JevEvaluationFailure extends Error {
  constructor(
    readonly kind: 'deadline' | 'provider' | 'invalid_response',
    message: string,
    readonly metadata: {
      mode: 'live' | 'recorded';
      configuredModel: string;
      resolvedModel: string;
      providerRequestId: string | null;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      retryCount: number;
    },
  ) {
    super(message);
  }
}

export class JevOperationalJudgmentProvider implements OperationalJudgmentProviderPort<
  EvaluationInput,
  OperationalJudgments
> {
  constructor(
    private readonly transport: JevTransport,
    private readonly mode: 'live' | 'recorded',
    private readonly model = JEV_MODEL,
    private readonly deadlineMs = 10_000,
    private readonly maxAttempts = 3,
  ) {}

  async evaluate(
    input: EvaluationInput,
  ): Promise<OperationalJudgmentResult<OperationalJudgments>> {
    const request = buildJevRequest(input, this.model);
    const start = performance.now();
    let requestId: string | null = null;
    let resolvedModel = this.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let kind: JevEvaluationFailure['kind'] = 'provider';
    let message = 'Jev request failed';
    let attempt = 0;
    let attemptsMade = 0;
    for (; attempt < this.maxAttempts; attempt++) {
      const remaining = this.deadlineMs - (performance.now() - start);
      if (remaining <= 0) {
        kind = 'deadline';
        message = 'Evaluation deadline exceeded';
        break;
      }
      try {
        attemptsMade++;
        const result = await this.transport.send(
          request,
          AbortSignal.timeout(Math.ceil(remaining)),
        );
        requestId = result.requestId;
        if (result.status !== 200) {
          kind = 'provider';
          message = `Evaluation provider returned HTTP ${result.status}`;
          if (![429, 500, 502, 503, 504, 529].includes(result.status)) break;
        } else {
          try {
            const envelope = responseSchema.parse(result.body);
            resolvedModel = envelope.model;
            inputTokens = envelope.usage.input_tokens;
            outputTokens = envelope.usage.output_tokens;
            const normalized = normalizeResponse(result.body, input.candidates);
            return {
              judgments: normalized.judgments,
              incidentMatches: normalized.incidentMatches,
              mode: this.mode,
              configuredModel: this.model,
              resolvedModel,
              providerRequestId: requestId,
              inputTokens,
              outputTokens,
              latencyMs: performance.now() - start,
              retryCount: attempt,
            };
          } catch (error) {
            kind = 'invalid_response';
            message =
              error instanceof Error
                ? error.message
                : 'Invalid TypeSafe response';
            break;
          }
        }
      } catch (error) {
        kind = 'provider';
        message =
          error instanceof Error ? error.message : 'TypeSafe request failed';
        if (error instanceof Error && error.name === 'TimeoutError')
          kind = 'deadline';
      }
      if (kind === 'deadline') break;
      if (attempt + 1 < this.maxAttempts) {
        const delay = Math.min(
          200 * 2 ** attempt,
          this.deadlineMs - (performance.now() - start),
        );
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new JevEvaluationFailure(kind, message, {
      mode: this.mode,
      configuredModel: this.model,
      resolvedModel,
      providerRequestId: requestId,
      inputTokens,
      outputTokens,
      latencyMs: performance.now() - start,
      retryCount: Math.max(0, attemptsMade - 1),
    });
  }
}
