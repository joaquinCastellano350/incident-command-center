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
import {
  ReviewQueueSchema,
  type ReviewQueue,
} from '@incident-command-center/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  subscribeToTriageQueue,
  type TriageQueueConnectionMode,
} from '../triage/triage-queue-client';

export function ReviewQueueView({
  apiBaseUrl,
  initialQueue,
}: {
  apiBaseUrl: string;
  initialQueue: ReviewQueue;
}) {
  const [queue, setQueue] = useState(initialQueue);
  const [mode, setMode] = useState<TriageQueueConnectionMode>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/review-tasks`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Review Task request failed');
        const next = ReviewQueueSchema.parse(await response.json());
        if (active) {
          setQueue(next);
          setError(null);
        }
      } catch {
        if (active) setError('Review Tasks could not be refreshed.');
      }
    };
    const stop = subscribeToTriageQueue({
      apiBaseUrl,
      onQueue: () => void refresh(),
      onMode: setMode,
      onError: (message) => {
        if (message) setError(message);
      },
    });
    return () => {
      active = false;
      stop();
    };
  }, [apiBaseUrl]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Button asChild variant="ghost" size="sm">
        <Link href="/triage">Triage Queue</Link>
      </Button>
      <Separator className="my-6" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Review Tasks
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Urgent work first, then oldest received Signal.
          </p>
        </div>
        <Badge variant="outline">
          {mode === 'live'
            ? 'Live updates'
            : mode === 'polling'
              ? 'Polling fallback'
              : 'Connecting'}
        </Badge>
      </div>
      {error && (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>Update connection degraded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Open reviews</CardTitle>
          <CardDescription>
            {queue.items.length} {queue.items.length === 1 ? 'task' : 'tasks'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Urgency</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Received (UTC)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.items.map(({ reviewTask, triageCase }) => (
                <TableRow key={reviewTask.id}>
                  <TableCell>
                    <Badge
                      variant={
                        reviewTask.urgency === 'urgent'
                          ? 'destructive'
                          : 'secondary'
                      }
                    >
                      {reviewTask.urgency}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="link" size="sm" className="px-0">
                      <Link href={`/triage/${triageCase.id}`}>
                        {triageCase.sourceReference}
                      </Link>
                    </Button>
                  </TableCell>
                  <TableCell className="max-w-md text-sm">
                    {reviewTask.reason}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(triageCase.receivedAt).toLocaleString('en-US', {
                      timeZone: 'UTC',
                    })}{' '}
                    UTC
                  </TableCell>
                </TableRow>
              ))}
              {queue.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No open Review Tasks.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
