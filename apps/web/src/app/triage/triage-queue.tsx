'use client';

import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Separator } from '#components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';
import { Activity, CircleAlert, Inbox, Radio, RefreshCw } from 'lucide-react';
import {
  type TriageCase,
  type TriageQueue,
} from '@incident-command-center/contracts';
import { useEffect, useState } from 'react';
import Link from 'next/link';

import {
  subscribeToTriageQueue,
  type TriageQueueConnectionMode,
} from './triage-queue-client';

interface TriageQueueViewProperties {
  apiBaseUrl: string;
  initialQueue: TriageQueue;
}

function formatReceiptTime(receivedAt: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(receivedAt));
}

function statusLabel(status: TriageCase['status']): string {
  if (status === 'queued') return 'Queued';
  if (status === 'incident_created') return 'Incident created';
  if (status === 'needs_review') return 'Needs review';
  return 'Ready for evaluation';
}

export function TriageQueueView({
  apiBaseUrl,
  initialQueue,
}: TriageQueueViewProperties) {
  const [queue, setQueue] = useState(initialQueue);
  const [mode, setMode] = useState<TriageQueueConnectionMode>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeToTriageQueue({
      apiBaseUrl,
      onQueue: setQueue,
      onMode: setMode,
      onError: setError,
    });
  }, [apiBaseUrl]);

  const live = mode === 'live';
  const connectionLabel =
    mode === 'live'
      ? 'Live updates'
      : mode === 'polling'
        ? 'Polling fallback'
        : 'Connecting';

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity className="size-4" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Incident Command Center</p>
            <p className="text-xs text-muted-foreground">Northstar Market</p>
          </div>
        </div>
        <Badge variant="outline" className="gap-1.5">
          {live ? (
            <Radio aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          {connectionLabel}
        </Badge>
      </header>
      <Separator className="my-6" />
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Triage Queue</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Incoming Signals and their durable processing state. A Triage Case
          remains distinct from an Incident until a later decision.
        </p>
      </section>

      {error && (
        <Alert variant="destructive" className="mt-6">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Update connection degraded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Incoming Triage Cases</CardTitle>
          <CardDescription>
            {queue.items.length} {queue.items.length === 1 ? 'case' : 'cases'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {queue.items.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md border border-dashed text-center">
              <Inbox
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">No Triage Cases yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Submitted Monitoring Alerts will appear here.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Source reference</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Received (UTC)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.items.map((triageCase) => (
                    <TableRow key={triageCase.id}>
                      <TableCell>
                        <Badge variant="secondary">
                          {statusLabel(triageCase.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          asChild
                          variant="link"
                          size="sm"
                          className="h-auto px-0 font-mono text-xs"
                        >
                          <Link href={`/triage/${triageCase.id}`}>
                            {triageCase.sourceReference}
                          </Link>
                        </Button>
                      </TableCell>
                      <TableCell className="font-medium">
                        {triageCase.service}
                      </TableCell>
                      <TableCell>{triageCase.region ?? 'Unknown'}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatReceiptTime(triageCase.receivedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
