'use client';

import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Textarea } from '#components/ui/textarea';
import type {
  IncidentDetail,
  IncidentLifecycleCommand,
} from '@incident-command-center/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const actionLabel: Record<IncidentLifecycleCommand['status'], string> = {
  open: 'Reopen Incident',
  acknowledged: 'Acknowledge Incident',
  mitigated: 'Mark mitigated',
  resolved: 'Resolve Incident',
};

export function IncidentLifecycleActions({
  apiBaseUrl,
  incidentId,
  nextStatus,
}: {
  apiBaseUrl: string;
  incidentId: string;
  nextStatus: IncidentDetail['nextLifecycleStatus'];
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [operatorKey, setOperatorKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/incidents/${incidentId}/lifecycle`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify({
            actor: 'demo-operator',
            reason,
            status: nextStatus,
          } satisfies IncidentLifecycleCommand),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Incident transition failed');
      }
      setReason('');
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Incident transition failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Incident lifecycle</CardTitle>
        <CardDescription>
          Record the Operator decision and reason in the immutable timeline.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-xl gap-4">
          <div className="grid gap-2">
            <Label htmlFor="lifecycle-operator-key">Operator access key</Label>
            <Input
              id="lifecycle-operator-key"
              type="password"
              autoComplete="off"
              value={operatorKey}
              onChange={(event) => setOperatorKey(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lifecycle-reason">Reason</Label>
            <Textarea
              id="lifecycle-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={1}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Could not change Incident state</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : actionLabel[nextStatus]}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
