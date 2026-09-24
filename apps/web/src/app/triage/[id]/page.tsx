import { Button } from '#components/ui/button';
import { Badge } from '#components/ui/badge';
import { DecisionTrace } from '#components/decision-trace';
import { ReviewActions } from '#components/review-actions';
import { ReevaluationActions } from '#components/reevaluation-actions';
import { EvaluationStatusRefresh } from '#components/evaluation-status-refresh';
import { Separator } from '#components/ui/separator';
import { TriageCaseDetailSchema } from '@incident-command-center/contracts';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

async function loadTriageCase(apiBaseUrl: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/api/v1/triage-cases/${id}`, {
    cache: 'no-store',
  });
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Triage Case request failed');
  return TriageCaseDetailSchema.parse(await response.json());
}

export default async function TriageCasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await loadTriageCase(process.env.API_INTERNAL_BASE_URL!, id);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <EvaluationStatusRefresh
        active={
          detail.evaluationProgress?.status === 'pending' ||
          detail.evaluationProgress?.status === 'retrying'
        }
      />
      <Button asChild variant="ghost" size="sm">
        <Link href="/triage">
          <ArrowLeft data-icon="inline-start" />
          Triage Queue
        </Link>
      </Button>
      <Separator className="my-6" />
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm text-muted-foreground">Triage Case</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {detail.triageCase.sourceReference}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {detail.signal.service} · {detail.signal.region ?? 'Unknown region'}
          </p>
          {detail.evaluation && (
            <Badge
              className="mt-3"
              variant={
                detail.evaluation.mode === 'live' ? 'default' : 'outline'
              }
            >
              {detail.evaluation.mode === 'recorded'
                ? 'Recorded fixture Evaluation'
                : detail.evaluation.mode === 'live'
                  ? 'Live Jev Evaluation'
                  : 'Deterministic Evaluation'}
            </Badge>
          )}
          <Badge
            className="mt-3 ml-2"
            variant={
              detail.evaluationProgress?.status === 'failed'
                ? 'destructive'
                : 'secondary'
            }
          >
            Evaluation {detail.evaluationProgress?.status ?? 'pending'}
          </Badge>
        </div>
        {detail.incidentId && (
          <Button asChild variant="outline">
            <Link href={`/incidents/${detail.incidentId}`}>
              Open Incident
              <ExternalLink data-icon="inline-end" />
            </Link>
          </Button>
        )}
      </header>
      <DecisionTrace
        signal={detail.signal}
        evaluation={detail.evaluation}
        evaluationHistory={detail.evaluationHistory}
        evaluationProgress={detail.evaluationProgress}
        evaluationProgressHistory={detail.evaluationProgressHistory}
        reviewTask={detail.reviewTask}
        corroboratingFacts={detail.corroboratingFacts}
        policyDecision={detail.policyDecision}
        policyDecisionHistory={detail.policyDecisionHistory}
        workflowActions={detail.workflowActions}
        timelineEvents={detail.timelineEvents}
        humanOverrides={detail.humanOverrides}
      />
      {detail.evaluation &&
        !['pending', 'retrying'].includes(
          detail.evaluationProgress?.status ?? '',
        ) &&
        process.env.PUBLIC_DEMO_READ_ONLY !== 'true' && (
          <ReevaluationActions
            apiBaseUrl={process.env.PUBLIC_API_BASE_URL!}
            triageCaseId={detail.triageCase.id}
            questionSetVersion={detail.evaluation.questionSetVersion}
            policyVersion={detail.evaluation.policyVersion}
          />
        )}
      {detail.reviewTask &&
        !detail.reviewTask.resolvedAt &&
        process.env.PUBLIC_DEMO_READ_ONLY !== 'true' && (
          <ReviewActions
            apiBaseUrl={process.env.PUBLIC_API_BASE_URL!}
            triageCaseId={detail.triageCase.id}
            status={detail.triageCase.status}
          />
        )}
    </main>
  );
}
