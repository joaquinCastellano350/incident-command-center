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
import { NativeSelect, NativeSelectOption } from '#components/ui/native-select';
import { Textarea } from '#components/ui/textarea';
import type {
  ReviewCommand,
  TriageCase,
} from '@incident-command-center/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const operator = 'demo-operator';

export function ReviewActions({
  apiBaseUrl,
  triageCaseId,
  status,
}: {
  apiBaseUrl: string;
  triageCaseId: string;
  status: TriageCase['status'];
}) {
  const router = useRouter();
  const [action, setAction] = useState<ReviewCommand['resolution']['type']>(
    status === 'incident_created'
      ? 'assign_owner'
      : status === 'evidence_linked'
        ? 'accept_link'
        : 'dismiss',
  );
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [owningDomain, setOwningDomain] = useState<
    'payments' | 'authentication' | 'fulfillment' | 'platform' | 'unknown'
  >('authentication');
  const [incidentId, setIncidentId] = useState('');
  const [operatorKey, setOperatorKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const resolution: ReviewCommand['resolution'] =
      action === 'create_incident'
        ? { type: action, priority, owningDomain }
        : action === 'link_incident'
          ? { type: action, incidentId }
          : action === 'assign_owner'
            ? {
                type: action,
                owningDomain: owningDomain as Exclude<
                  typeof owningDomain,
                  'unknown'
                >,
              }
            : { type: action };
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/review-tasks/${triageCaseId}/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify({ actor: operator, reason, resolution }),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Review resolution failed');
      }
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Review resolution failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Resolve Review Task</CardTitle>
        <CardDescription>
          Operator actions are recorded as Human Overrides. No automatic page is
          sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-xl gap-4">
          <div className="grid gap-2">
            <Label htmlFor="review-operator-key">Operator access key</Label>
            <Input
              id="review-operator-key"
              type="password"
              autoComplete="off"
              value={operatorKey}
              onChange={(event) => setOperatorKey(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="review-action">Resolution</Label>
            <NativeSelect
              id="review-action"
              value={action}
              onChange={(event) =>
                setAction(event.target.value as typeof action)
              }
            >
              {status === 'needs_review' && (
                <>
                  <NativeSelectOption value="dismiss">
                    Dismiss Triage Case
                  </NativeSelectOption>
                  <NativeSelectOption value="create_incident">
                    Create Incident
                  </NativeSelectOption>
                  <NativeSelectOption value="link_incident">
                    Create Evidence Link
                  </NativeSelectOption>
                </>
              )}
              {status === 'incident_created' && (
                <NativeSelectOption value="assign_owner">
                  Assign Primary Owning Domain
                </NativeSelectOption>
              )}
              {status === 'evidence_linked' && (
                <NativeSelectOption value="accept_link">
                  Accept Evidence Link
                </NativeSelectOption>
              )}
            </NativeSelect>
          </div>
          {action === 'create_incident' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="review-priority">Current Priority</Label>
                <NativeSelect
                  id="review-priority"
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as typeof priority)
                  }
                >
                  {(['P0', 'P1', 'P2', 'P3'] as const).map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {value}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="review-domain">Primary Owning Domain</Label>
                <NativeSelect
                  id="review-domain"
                  value={owningDomain}
                  onChange={(event) =>
                    setOwningDomain(event.target.value as typeof owningDomain)
                  }
                >
                  {(
                    [
                      'unknown',
                      'payments',
                      'authentication',
                      'fulfillment',
                      'platform',
                    ] as const
                  ).map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {value}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}
          {action === 'link_incident' && (
            <div className="grid gap-2">
              <Label htmlFor="review-incident">Existing Incident ID</Label>
              <Input
                id="review-incident"
                value={incidentId}
                onChange={(event) => setIncidentId(event.target.value)}
                required
              />
            </div>
          )}
          {action === 'assign_owner' && (
            <div className="grid gap-2">
              <Label htmlFor="review-assigned-domain">
                Primary Owning Domain
              </Label>
              <NativeSelect
                id="review-assigned-domain"
                value={owningDomain}
                onChange={(event) =>
                  setOwningDomain(event.target.value as typeof owningDomain)
                }
              >
                {(
                  [
                    'payments',
                    'authentication',
                    'fulfillment',
                    'platform',
                  ] as const
                ).map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="review-reason">Reason</Label>
            <Textarea
              id="review-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={1}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Could not resolve review</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Record resolution'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function PriorityOverrideActions({
  apiBaseUrl,
  incidentId,
  currentPriority,
}: {
  apiBaseUrl: string;
  incidentId: string;
  currentPriority: 'P0' | 'P1' | 'P2' | 'P3';
}) {
  const router = useRouter();
  const [priority, setPriority] = useState(currentPriority);
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
        `${apiBaseUrl}/api/v1/incidents/${incidentId}/priority-override`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify({ actor: operator, reason, priority }),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Priority override failed');
      }
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Priority override failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Set Current Priority</CardTitle>
        <CardDescription>
          The original Priority Assessment remains in the Evaluation history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-xl gap-4">
          <div className="grid gap-2">
            <Label htmlFor="priority-operator-key">Operator access key</Label>
            <Input
              id="priority-operator-key"
              type="password"
              autoComplete="off"
              value={operatorKey}
              onChange={(event) => setOperatorKey(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="current-priority">Current Priority</Label>
            <NativeSelect
              id="current-priority"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as typeof priority)
              }
            >
              {(['P0', 'P1', 'P2', 'P3'] as const).map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="priority-reason">Reason</Label>
            <Textarea
              id="priority-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={1}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Could not set priority</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Record priority override'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
