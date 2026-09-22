import { Badge } from '#components/ui/badge';
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
  PolicyDecision,
  Signal,
  TimelineEvent,
  WorkflowAction,
} from '@incident-command-center/contracts';

interface DecisionTraceProperties {
  signal: Signal;
  evaluation: Evaluation | null;
  corroboratingFacts: CorroboratingFact[];
  policyDecision: PolicyDecision | null;
  workflowActions: WorkflowAction[];
  timelineEvents: TimelineEvent[];
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
    String(value),
  ]);
}

export function DecisionTrace({
  signal,
  evaluation,
  corroboratingFacts,
  policyDecision,
  workflowActions,
  timelineEvents,
}: DecisionTraceProperties) {
  const choiceJudgments = evaluation
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
            <Card>
              <CardHeader>
                <CardTitle>Operational Judgments</CardTitle>
                <CardDescription>
                  {evaluation.resolvedModel} · {evaluation.questionSetVersion}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {choiceJudgments.map(([judgmentLabel, judgment]) => (
                  <div key={judgmentLabel} className="rounded-md border p-4">
                    <p className="text-xs text-muted-foreground">
                      {judgmentLabel}
                    </p>
                    <p className="mt-1 font-medium">{label(judgment.choice)}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {judgment.probabilities
                        .map(
                          (item) =>
                            `${label(item.outcome)} ${(item.probability * 100).toFixed(0)}%`,
                        )
                        .join(' · ')}
                    </p>
                  </div>
                ))}
                <div className="rounded-md border p-4">
                  <p className="text-xs text-muted-foreground">
                    Evidence Sufficiency
                  </p>
                  <p className="mt-1 font-medium">
                    {(
                      evaluation.judgments.evidenceSufficiency.yesProbability *
                      100
                    ).toFixed(0)}
                    % yes
                  </p>
                </div>
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
        <Card>
          <CardHeader>
            <CardTitle>Workflow Actions</CardTitle>
            <CardDescription>
              Authorized effects and provider correlations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {workflowActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Workflow Actions have run.
              </p>
            ) : (
              workflowActions.map((action) => (
                <div key={action.id} className="rounded-md border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{label(action.type)}</p>
                    <Badge variant="secondary">{label(action.status)}</Badge>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                    {action.idempotencyKey}
                  </p>
                  {action.providerReference && (
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      Provider: {action.providerReference}
                    </p>
                  )}
                </div>
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
