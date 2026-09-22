import { Button } from '#components/ui/button';
import { DecisionTrace } from '#components/decision-trace';
import { Separator } from '#components/ui/separator';
import { IncidentDetailSchema } from '@incident-command-center/contracts';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

async function loadIncident(apiBaseUrl: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/api/v1/incidents/${id}`, {
    cache: 'no-store',
  });
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Incident request failed');
  return IncidentDetailSchema.parse(await response.json());
}

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await loadIncident(process.env.API_INTERNAL_BASE_URL!, id);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Button asChild variant="ghost" size="sm">
        <Link href="/triage">
          <ArrowLeft data-icon="inline-start" />
          Triage Queue
        </Link>
      </Button>
      <Separator className="my-6" />
      <header>
        <p className="text-sm text-muted-foreground">Incident</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {detail.incident.title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {detail.incident.currentPriority} ·{' '}
          {detail.incident.primaryOwningDomain} · {detail.incident.status}
        </p>
      </header>

      <DecisionTrace
        signal={detail.signal}
        evaluation={detail.evaluation}
        reviewTask={detail.reviewTask}
        corroboratingFacts={detail.corroboratingFacts}
        policyDecision={detail.policyDecision}
        workflowActions={detail.workflowActions}
        timelineEvents={detail.timelineEvents}
      />
    </main>
  );
}
