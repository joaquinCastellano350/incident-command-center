import { Badge } from '#components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs';
import type {
  CorroboratingFact,
  Evaluation,
  ReviewTask,
  PolicyDecision,
  Signal,
  TimelineEvent,
  WorkflowAction,
  HumanOverride,
} from '@incident-command-center/contracts';

interface DecisionTraceProperties {
  signal: Signal;
  evaluation: Evaluation | null;
  reviewTask?: ReviewTask | null;
  corroboratingFacts: CorroboratingFact[];
  policyDecision: PolicyDecision | null;
  workflowActions: WorkflowAction[];
  timelineEvents: TimelineEvent[];
  humanOverrides?: HumanOverride[];
}

function label(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function facts(signal: Signal): Array<[string, string]> {
  return Object.entries(signal.facts).map(([key, value]) => [
    label(key),
    value === null ? 'Unknown' : String(value),
  ]);
}

function executionCount(action: WorkflowAction): number {
  const started = action.attempts.filter(
    (attempt) => attempt.outcome === 'started',
  ).length;
  const completed = action.attempts.filter((attempt) =>
    [
      'succeeded',
      'transient_failure',
      'permanent_failure',
      'interrupted',
    ].includes(attempt.outcome),
  ).length;
  return Math.max(started, completed);
}

export function DecisionTrace({
  signal,
  evaluation,
  reviewTask,
  corroboratingFacts,
  policyDecision,
  workflowActions,
  timelineEvents,
  humanOverrides = [],
}: DecisionTraceProperties) {
  const choiceJudgments = evaluation?.judgments
    ? ([
        ['Priority Assessment', evaluation.judgments.priorityAssessment],
        ['Customer Reach', evaluation.judgments.customerReach],
        ['Regional Reach', evaluation.judgments.regionalReach],
        ['Service Breadth', evaluation.judgments.serviceBreadth],
        ['Primary Owning Domain', evaluation.judgments.primaryOwningDomain],
      ] as const)
    : [];

  return (
    <Tabs defaultValue="signal" className="mt-6">
      <TabsList variant="line" className="max-w-full overflow-x-auto">
        <TabsTrigger value="signal">Signal</TabsTrigger>
        <TabsTrigger value="judgments">Judgments</TabsTrigger>
        <TabsTrigger value="policy">Policy</TabsTrigger>
        <TabsTrigger value="actions">Actions</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="review">Human Review</TabsTrigger>
      </TabsList>

      <TabsContent value="signal" className="mt-4 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Source evidence</CardTitle>
            <CardDescription>
              Immutable normalized {label(signal.sourceType)}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Source reference" value={signal.sourceReference} />
            <Detail label="Service" value={signal.service} />
            <Detail label="Region" value={signal.region ?? 'Unknown'} />
            <Detail label="Occurred" value={signal.occurredAt} />
            <Detail label="Received" value={signal.receivedAt} />
            <Detail label="Correlation ID" value={signal.correlationId} />
            <Detail
              label="Normalization"
              value={`v${signal.normalizationVersion}`}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Structured facts</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {facts(signal).map(([factLabel, value]) => (
              <Detail key={factLabel} label={factLabel} value={value} />
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="judgments" className="mt-4 space-y-4">
        {evaluation ? (
          <>
            <Alert>
              <AlertTitle className="flex items-center gap-2">
                Evaluation{' '}
                <Badge
                  variant={evaluation.mode === 'live' ? 'default' : 'outline'}
                >
                  {label(evaluation.mode)} mode
                </Badge>
                <Badge
                  variant={
                    evaluation.status === 'failed' ? 'destructive' : 'secondary'
                  }
                >
                  {label(evaluation.status)}
                </Badge>
              </AlertTitle>
              <AlertDescription>
                {evaluation.mode === 'recorded'
                  ? 'Replayed response fixture; this is not a fresh Jev call.'
                  : evaluation.mode === 'deterministic'
                    ? 'Deterministic test Evaluation.'
                    : 'Live Jev response.'}
              </AlertDescription>
            </Alert>
            {evaluation.failure && (
              <Alert variant="destructive">
                <AlertTitle>Evaluation failed</AlertTitle>
                <AlertDescription>
                  {evaluation.failure.kind}: {evaluation.failure.message}
                </AlertDescription>
              </Alert>
            )}
            {reviewTask && (
              <Alert>
                <AlertTitle>
                  Review Task · {label(reviewTask.urgency)}
                </AlertTitle>
                <AlertDescription>{reviewTask.reason}</AlertDescription>
              </Alert>
            )}
            <Card>
              <CardHeader>
                <CardTitle>Operational Judgments</CardTitle>
                <CardDescription>
                  {evaluation.resolvedModel} · {evaluation.questionSetVersion} ·{' '}
                  {evaluation.latencyMs.toFixed(0)} ms · {evaluation.retryCount}{' '}
                  retries
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {choiceJudgments.map(([judgmentLabel, judgment]) => (
                  <ChoiceAnswer
                    key={judgmentLabel}
                    title={judgmentLabel}
                    judgment={judgment}
                  />
                ))}
                {evaluation.judgments && (
                  <Card size="sm">
                    <CardContent>
                      <p className="text-xs text-muted-foreground">
                        Evidence Sufficiency
                      </p>
                      <p className="mt-1 font-medium">
                        {
                          evaluation.judgments.evidenceSufficiency
                            .yesProbability
                        }{' '}
                        yes probability
                      </p>
                    </CardContent>
                  </Card>
                )}
                {evaluation.incidentMatches.map((match) => (
                  <ChoiceAnswer
                    key={match.candidateIncidentId}
                    title={`Incident Match · ${match.candidateIncidentId}`}
                    judgment={match.judgment}
                  />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Evaluation audit</CardTitle>
                <CardDescription>
                  Provider and version details for this immutable result
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Attempt ID" value={evaluation.attemptId} />
                <Detail
                  label="Provider request ID"
                  value={evaluation.providerRequestId ?? 'Unavailable'}
                />
                <Detail
                  label="Configured model"
                  value={evaluation.configuredModel}
                />
                <Detail
                  label="Returned model"
                  value={evaluation.resolvedModel}
                />
                <Detail
                  label="Decision schema"
                  value={evaluation.decisionSchemaVersion}
                />
                <Detail
                  label="Question set"
                  value={evaluation.questionSetVersion}
                />
                <Detail
                  label="Input tokens"
                  value={String(evaluation.inputTokens)}
                />
                <Detail
                  label="Output tokens"
                  value={String(evaluation.outputTokens)}
                />
                <Detail
                  label="Local latency"
                  value={`${evaluation.latencyMs.toFixed(0)} ms`}
                />
                <Detail label="Retries" value={String(evaluation.retryCount)} />
                <Detail label="Evaluated at" value={evaluation.evaluatedAt} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Corroborating Facts</CardTitle>
                <CardDescription>
                  Machine-verifiable conditions used by policy
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {corroboratingFacts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No Corroborating Facts were found.
                  </p>
                ) : (
                  corroboratingFacts.map((fact) => (
                    <div key={fact.id} className="rounded-md border p-4">
                      <Badge variant="outline">{label(fact.kind)}</Badge>
                      <p className="mt-2 text-sm">{fact.summary}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              Evaluation has not completed.
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="policy" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Policy Decision</CardTitle>
            <CardDescription>
              {policyDecision?.version ?? 'Waiting for evaluation'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {policyDecision && (
              <div className="mb-4 grid gap-4 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
                <Detail
                  label="Priority probability"
                  value={`${policyDecision.thresholds.priorityChoiceProbability * 100}%`}
                />
                <Detail
                  label="Impact probability"
                  value={`${policyDecision.thresholds.impactChoiceProbability * 100}%`}
                />
                <Detail
                  label="Ownership probability"
                  value={`${policyDecision.thresholds.ownershipChoiceProbability * 100}%`}
                />
                <Detail
                  label="Evidence Sufficiency"
                  value={`${policyDecision.thresholds.evidenceSufficiencyYesProbability * 100}%`}
                />
                {policyDecision.thresholds.incidentMatchChoiceProbability !==
                  undefined && (
                  <Detail
                    label="Incident Match probability"
                    value={`${policyDecision.thresholds.incidentMatchChoiceProbability * 100}%`}
                  />
                )}
              </div>
            )}
            {policyDecision?.rules.map((rule) => (
              <div key={rule.ruleId} className="rounded-md border p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{label(rule.action)}</p>
                  <Badge
                    variant={
                      rule.outcome === 'authorized' ? 'secondary' : 'outline'
                    }
                  >
                    {label(rule.outcome)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {rule.explanation}
                </p>
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  {rule.ruleId}
                </p>
              </div>
            )) ?? (
              <p className="text-sm text-muted-foreground">
                Policy has not run.
              </p>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="actions" className="mt-4">
        {reviewTask?.urgency === 'urgent' && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Operator attention required</AlertTitle>
            <AlertDescription>{reviewTask.reason}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Workflow Actions</CardTitle>
            <CardDescription>
              Current state, provider effects, retries, and duplicate
              suppression
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {workflowActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Workflow Actions have run.
              </p>
            ) : (
              workflowActions.map((action) => (
                <Card key={action.id} size="sm">
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-medium">{label(action.type)}</p>
                      <Badge
                        variant={
                          action.status === 'permanently_failed'
                            ? 'destructive'
                            : action.status === 'succeeded'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {label(action.status)}
                      </Badge>
                    </div>
                    <div className="grid gap-3 text-sm sm:grid-cols-2">
                      <Detail
                        label="Policy Decision"
                        value={action.policyDecisionId}
                      />
                      <Detail
                        label="Idempotency key"
                        value={action.idempotencyKey}
                      />
                      <Detail
                        label="Provider reference"
                        value={action.providerReference ?? 'Pending'}
                      />
                      <Detail
                        label="Attempts"
                        value={`${executionCount(action)} of ${action.maxAttempts}`}
                      />
                      <Detail
                        label="Duplicates suppressed"
                        value={String(action.suppressedCount)}
                      />
                      {action.nextRetryAt && (
                        <Detail label="Next retry" value={action.nextRetryAt} />
                      )}
                    </div>
                    {action.failureReason && (
                      <Alert
                        variant={
                          action.status === 'permanently_failed'
                            ? 'destructive'
                            : 'default'
                        }
                      >
                        <AlertTitle>
                          {action.status === 'permanently_failed'
                            ? 'Terminal failure'
                            : 'Retry scheduled'}
                        </AlertTitle>
                        <AlertDescription>
                          {action.failureReason}
                        </AlertDescription>
                      </Alert>
                    )}
                    {action.attempts.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">
                          Action Attempts
                        </p>
                        <ol className="mt-2 space-y-2 text-sm">
                          {action.attempts.map((attempt) => (
                            <li
                              key={attempt.id}
                              className="flex flex-wrap gap-x-3 gap-y-1"
                            >
                              <span className="font-mono text-xs text-muted-foreground">
                                #{attempt.sequence}
                              </span>
                              <span>{label(attempt.outcome)}</span>
                              <time className="text-xs text-muted-foreground">
                                {attempt.attemptedAt}
                              </time>
                              {attempt.providerReference && (
                                <span className="break-all text-xs">
                                  {attempt.providerReference}
                                </span>
                              )}
                              {attempt.detail && (
                                <span className="w-full text-xs text-muted-foreground">
                                  {attempt.detail}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="timeline" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Timeline Events</CardTitle>
            <CardDescription>Immutable Incident history</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {timelineEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Incident Timeline Events have been recorded.
              </p>
            ) : (
              timelineEvents.map((event) => (
                <div key={event.id} className="rounded-md border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <p className="font-medium">{label(event.type)}</p>
                    <time className="text-xs text-muted-foreground">
                      {event.occurredAt}
                    </time>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {event.summary}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="review" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Human Overrides</CardTitle>
            <CardDescription>
              Operator decisions preserve the original Evaluation and Policy
              Decision.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {humanOverrides.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Human Overrides recorded.
              </p>
            ) : (
              humanOverrides.map((override) => (
                <div key={override.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {label(override.replacementOutcome.type)}
                    </p>
                    <time className="text-xs text-muted-foreground">
                      {override.recordedAt}
                    </time>
                  </div>
                  <p className="mt-2 text-sm">{override.reason}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {override.actor} ·{' '}
                    {override.replacementOutcome.type === 'set_priority' ||
                    override.replacementOutcome.type === 'create_incident'
                      ? `Current Priority ${override.replacementOutcome.priority}`
                      : override.replacementOutcome.type === 'link_incident'
                        ? `Incident ${override.replacementOutcome.incidentId}`
                        : override.replacementOutcome.type === 'assign_owner'
                          ? `Primary Owning Domain ${override.replacementOutcome.owningDomain}`
                          : override.replacementOutcome.type === 'accept_link'
                            ? 'Existing Evidence Link accepted'
                            : 'Triage Case dismissed'}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
    </div>
  );
}

function ChoiceAnswer({
  title,
  judgment,
}: {
  title: string;
  judgment: {
    choice: string;
    confidence?: number | undefined;
    probabilities: Array<{ outcome: string; probability: number }>;
  };
}) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs text-muted-foreground">{title}</p>
        <p className="mt-1 font-medium">{label(judgment.choice)}</p>
        {judgment.confidence !== undefined && (
          <p className="mt-1 text-xs text-muted-foreground">
            Choice confidence {judgment.confidence}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {judgment.probabilities
            .map(
              (item) =>
                `${label(item.outcome)} ${item.probability} (${(item.probability * 100).toFixed(2)}%)`,
            )
            .join(' · ')}
        </p>
      </CardContent>
    </Card>
  );
}
