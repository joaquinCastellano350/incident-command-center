import { Button } from '#components/ui/button';
import { DecisionTrace } from '#components/decision-trace';
import { Separator } from '#components/ui/separator';
import { Badge } from '#components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';
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

      <section className="mt-8" aria-labelledby="incident-evidence-heading">
        <h2 id="incident-evidence-heading" className="text-lg font-semibold">
          Linked Signals
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customer evidence and the Incident Match Evaluation supporting each
          link.
        </p>
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Signal</TableHead>
              <TableHead>Reported</TableHead>
              <TableHead>Incident Match</TableHead>
              <TableHead>Evaluation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.evidenceLinks.map(({ link, signal, evaluation }) => {
              const match = evaluation.incidentMatches.find(
                (candidate) =>
                  candidate.candidateIncidentId === detail.incident.id,
              );
              const probability = match?.judgment.probabilities.find(
                (outcome) => outcome.outcome === match.judgment.choice,
              )?.probability;
              return (
                <TableRow key={link.id}>
                  <TableCell>
                    <span className="font-medium">
                      {signal.title ?? signal.sourceReference}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {signal.sourceReference}
                    </span>
                  </TableCell>
                  <TableCell>
                    {new Date(signal.occurredAt).toLocaleString('en-US', {
                      timeZone: 'UTC',
                    })}{' '}
                    UTC
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {match?.judgment.choice ?? 'unknown'}
                    </Badge>
                    {probability !== undefined && (
                      <span className="ml-2 text-sm text-muted-foreground">
                        {Math.round(probability * 100)}%
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="link" size="sm" className="px-0">
                      <Link href={`/triage/${evaluation.triageCaseId}`}>
                        View decision
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {detail.evidenceLinks.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No linked Signals yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

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
