import { randomUUID } from 'node:crypto';

import type {
  AssistantProvider,
  AssistantProviderRequest,
  AssistantSystem,
} from '@incident-command-center/application';
import {
  AssistantEvidenceSchema,
  AssistantInteractionSchema,
  AssistantOutputSchema,
  PublishedUpdateSchema,
  type AssistantCommand,
  type AssistantEvidence,
  type AssistantInteraction,
  type PublishedUpdate,
} from '@incident-command-center/contracts';
import type { Clock } from '@incident-command-center/domain';
import { Pool } from 'pg';

import { ensureApplicationSchema } from './index.js';

export class PublishConflictError extends Error {}
export class AssistantQuotaError extends Error {}

function redactedEvidenceText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\b(?:\+?\d[\d(). -]{8,}\d)\b/g, '[redacted number]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)\b/gi,
      '[redacted credential]',
    )
    .slice(0, 1000);
}

interface AssistantOptions {
  connectionString: string;
  clock: Clock;
  provider: AssistantProvider;
  mode: 'live' | 'recorded';
  configuredModel: string;
  configurationVersion?: string;
}

export class PostgresAssistantSystem implements AssistantSystem {
  private readonly pool: Pool;
  private readonly clock: Clock;
  private readonly provider: AssistantProvider;
  private readonly mode: 'live' | 'recorded';
  private readonly configuredModel: string;
  private readonly configurationVersion: string;

  constructor(options: AssistantOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
    this.clock = options.clock;
    this.provider = options.provider;
    this.mode = options.mode;
    this.configuredModel = options.configuredModel;
    this.configurationVersion =
      options.configurationVersion ?? 'incident-assistant.v1';
  }

  async start(): Promise<void> {
    await ensureApplicationSchema(this.pool);
  }
  async stop(): Promise<void> {
    await this.pool.end();
  }

  private async evidence(
    incidentId: string,
  ): Promise<AssistantEvidence | null> {
    const incident = await this.pool.query<{
      triage_case_id: string;
    }>('SELECT triage_case_id FROM incidents WHERE id = $1', [incidentId]);
    if (!incident.rows[0]) return null;
    const signalRows = await this.pool.query<{
      id: string;
      source_type: string;
      occurred_at: Date;
      service: string;
      region: string | null;
      title: string | null;
      content: string | null;
      facts: Record<string, unknown>;
      triage_case_id: string;
    }>(
      `SELECT s.id, s.source_type, s.occurred_at, s.service,
        s.region, s.title, s.content, s.facts, tc.id AS triage_case_id
       FROM triage_cases tc JOIN signals s ON s.id = tc.signal_id
       WHERE tc.id = $2 OR tc.id IN
         (SELECT triage_case_id FROM evidence_links WHERE incident_id = $1)
       ORDER BY s.occurred_at, s.id`,
      [incidentId, incident.rows[0].triage_case_id],
    );
    const caseIds = signalRows.rows.map((row) => row.triage_case_id);
    const [evaluations, decisions, events] = await Promise.all([
      this.pool.query<{
        triage_case_id: string;
        record: {
          id: string;
          judgments?: {
            priorityAssessment?: { choice: string };
            evidenceSufficiency?: { yesProbability: number };
          };
        };
      }>(
        `SELECT DISTINCT ON (triage_case_id) triage_case_id, record FROM evaluations
         WHERE triage_case_id = ANY($1::uuid[]) ORDER BY triage_case_id, sequence DESC`,
        [caseIds],
      ),
      this.pool.query<{
        triage_case_id: string;
        record: { id: string; authorizedActions: string[]; rules: unknown[] };
      }>(
        `SELECT DISTINCT ON (triage_case_id) triage_case_id, record FROM policy_decisions
         WHERE triage_case_id = ANY($1::uuid[]) ORDER BY triage_case_id, sequence DESC`,
        [caseIds],
      ),
      this.pool.query<{
        record: { id: string; type: string; occurredAt: string };
      }>(
        'SELECT record FROM timeline_events WHERE incident_id = $1 ORDER BY sequence',
        [incidentId],
      ),
    ]);
    const signalByCase = new Map(
      signalRows.rows.map((row) => [row.triage_case_id, row.id]),
    );
    const allowedFacts = (facts: Record<string, unknown>) =>
      Object.fromEntries(
        [
          'metric',
          'threshold',
          'observedValue',
          'evaluationWindowSeconds',
          'affectedOperation',
          'errorSignature',
          'occurrenceCount',
          'sampleMessages',
          'windowStartedAt',
          'windowEndedAt',
          'outcome',
        ]
          .filter((key) => key in facts)
          .map((key) => [
            key,
            typeof facts[key] === 'string'
              ? redactedEvidenceText(facts[key])
              : Array.isArray(facts[key])
                ? facts[key]
                    .filter((item): item is string => typeof item === 'string')
                    .slice(0, 3)
                    .map((item) => redactedEvidenceText(item))
                : facts[key],
          ]),
      );
    return AssistantEvidenceSchema.parse({
      signals: signalRows.rows.map((row) => ({
        id: row.id,
        sourceType: row.source_type,
        occurredAt: row.occurred_at.toISOString(),
        service: /^[a-z0-9_.:-]{1,100}$/i.test(row.service)
          ? row.service
          : 'unknown',
        region: row.region,
        title: redactedEvidenceText(row.title),
        content: redactedEvidenceText(row.content),
        facts: allowedFacts(row.facts),
      })),
      judgments: evaluations.rows.map((row) => ({
        signalId: signalByCase.get(row.triage_case_id),
        evaluationId: row.record.id,
        priorityAssessment:
          row.record.judgments?.priorityAssessment?.choice ?? null,
        evidenceSufficiencyYesProbability:
          row.record.judgments?.evidenceSufficiency?.yesProbability ?? null,
      })),
      policyDecisions: decisions.rows.map((row) => ({
        signalId: signalByCase.get(row.triage_case_id),
        policyDecisionId: row.record.id,
        authorizedActions: row.record.authorizedActions,
        rules: row.record.rules.map((rule) => {
          const item = rule as {
            ruleId: string;
            action: string;
            outcome: string;
          };
          return { ...item, explanation: 'Recorded policy rule result' };
        }),
      })),
      timelineEvents: events.rows.map(({ record }) => ({
        id: record.id,
        type: record.type,
        occurredAt: record.occurredAt,
        summary: record.type.replaceAll('_', ' '),
      })),
    });
  }

  async generate(
    incidentId: string,
    command: AssistantCommand,
  ): Promise<AssistantInteraction | null> {
    const evidence = await this.evidence(incidentId);
    if (!evidence) return null;
    const inputEvidenceReferences = [
      ...evidence.signals.map((signal) => ({
        type: 'signal' as const,
        id: signal.id,
      })),
      ...evidence.judgments.map((judgment) => ({
        type: 'evaluation' as const,
        id: judgment.evaluationId,
      })),
      ...evidence.policyDecisions.map((decision) => ({
        type: 'policy_decision' as const,
        id: decision.policyDecisionId,
      })),
      ...evidence.timelineEvents.map((event) => ({
        type: 'timeline_event' as const,
        id: event.id,
      })),
    ];
    const allowed = new Set(
      inputEvidenceReferences
        .filter((ref) => ref.type === 'signal' || ref.type === 'timeline_event')
        .map((ref) => `${ref.type}:${ref.id}`),
    );
    const request: AssistantProviderRequest = {
      model: this.configuredModel,
      configurationVersion: this.configurationVersion,
      command,
      evidence,
    };
    let last: AssistantInteraction | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.reserveProviderAttempt();
      const started = Date.now();
      let outcome: AssistantInteraction['outcome'] = 'accepted';
      let output: AssistantInteraction['output'] = null;
      let providerOutput: unknown = null;
      let returnedModel: string | null = null;
      let providerRequestId: string | null = null;
      let latencyMs = 0;
      try {
        const result = await this.provider.generate(request);
        providerOutput = result.output;
        returnedModel = result.returnedModel;
        providerRequestId = result.providerRequestId;
        latencyMs = result.latencyMs;
        const parsed = AssistantOutputSchema.safeParse(result.output);
        if (!parsed.success) outcome = 'invalid_response';
        else if (
          [
            ...parsed.data.claims,
            ...(parsed.data.draft ? [parsed.data.draft] : []),
          ].some((claim) =>
            claim.citations.some(
              (citation) => !allowed.has(`${citation.type}:${citation.id}`),
            ),
          )
        )
          outcome = 'invalid_citation';
        else if (
          (command.kind === 'status_draft') !==
          (parsed.data.draft !== null)
        )
          outcome = 'invalid_response';
        else output = parsed.data;
      } catch {
        outcome = 'provider_error';
        latencyMs = Date.now() - started;
      }
      last = AssistantInteractionSchema.parse({
        id: randomUUID(),
        incidentId,
        actor: command.actor,
        kind: command.kind,
        question: command.question ?? null,
        mode: this.mode,
        configurationVersion: this.configurationVersion,
        configuredModel: this.configuredModel,
        returnedModel,
        providerRequestId,
        providerRequest: request as unknown as Record<string, unknown>,
        inputEvidenceReferences,
        output,
        latencyMs,
        outcome,
        createdAt: this.clock.now().toISOString(),
      });
      await this.pool.query(
        'INSERT INTO assistant_interactions (id, incident_id, record, provider_output) VALUES ($1, $2, $3, $4)',
        [last.id, incidentId, last, JSON.stringify(providerOutput)],
      );
      if (outcome === 'accepted' || outcome === 'provider_error') break;
    }
    return last;
  }

  private async reserveProviderAttempt(): Promise<void> {
    const client = await this.pool.connect();
    const now = this.clock.now().toISOString();
    try {
      await client.query('BEGIN');
      const minute = await client.query(
        `INSERT INTO assistant_minute_quota (minute, used) VALUES (date_trunc('minute', $1::timestamptz), 1)
         ON CONFLICT (minute) DO UPDATE SET used = assistant_minute_quota.used + 1
         WHERE assistant_minute_quota.used < 10 RETURNING used`,
        [now],
      );
      if (!minute.rows.length)
        throw new AssistantQuotaError('Assistant rate limit reached');
      const day = await client.query(
        `INSERT INTO assistant_daily_quota (day, used) VALUES ($1::date, 1)
         ON CONFLICT (day) DO UPDATE SET used = assistant_daily_quota.used + 1
         WHERE assistant_daily_quota.used < 100 RETURNING used`,
        [now.slice(0, 10)],
      );
      if (!day.rows.length)
        throw new AssistantQuotaError('Daily assistant request limit reached');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async publish(
    incidentId: string,
    interactionId: string,
    actor: 'demo-operator',
  ): Promise<PublishedUpdate | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ record: AssistantInteraction }>(
        'SELECT record FROM assistant_interactions WHERE id = $1 AND incident_id = $2 FOR UPDATE',
        [interactionId, incidentId],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const interaction = AssistantInteractionSchema.parse(
        result.rows[0].record,
      );
      if (
        interaction.outcome !== 'accepted' ||
        interaction.kind !== 'status_draft' ||
        !interaction.output?.draft
      )
        throw new PublishConflictError(
          'Only an accepted status draft can be published',
        );
      const update = PublishedUpdateSchema.parse({
        id: randomUUID(),
        incidentId,
        assistantInteractionId: interactionId,
        actor,
        content: interaction.output.draft.text,
        publishedAt: this.clock.now().toISOString(),
      });
      const inserted = await client.query(
        'INSERT INTO published_updates (id, incident_id, assistant_interaction_id, record) VALUES ($1, $2, $3, $4) ON CONFLICT (assistant_interaction_id) DO NOTHING RETURNING id',
        [update.id, incidentId, interactionId, update],
      );
      if (!inserted.rows.length)
        throw new PublishConflictError('Status draft was already published');
      await client.query('COMMIT');
      return update;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresAssistantSystem(
  options: AssistantOptions,
): PostgresAssistantSystem {
  return new PostgresAssistantSystem(options);
}
