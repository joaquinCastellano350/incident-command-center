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
import { Input } from '#components/ui/input';
import { NativeSelect, NativeSelectOption } from '#components/ui/native-select';
import { Label } from '#components/ui/label';
import { Textarea } from '#components/ui/textarea';
import type {
  AssistantCommand,
  AssistantInteraction,
  PublishedUpdate,
} from '@incident-command-center/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function IncidentAssistant({
  apiBaseUrl,
  incidentId,
  interactions,
  publishedUpdates,
  readOnly,
}: {
  apiBaseUrl: string;
  incidentId: string;
  interactions: AssistantInteraction[];
  publishedUpdates: PublishedUpdate[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<AssistantCommand['kind']>('summary');
  const [question, setQuestion] = useState('');
  const [operatorKey, setOperatorKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/incidents/${incidentId}/assistant-interactions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify({
            actor: 'demo-operator',
            kind,
            ...(kind === 'question' ? { question } : {}),
          } satisfies AssistantCommand),
        },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error ?? 'Assistant request failed',
        );
      setQuestion('');
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Assistant request failed',
      );
    } finally {
      setPending(false);
    }
  }

  async function publish(interactionId: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/incidents/${incidentId}/assistant-interactions/${interactionId}/publish`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify({ actor: 'demo-operator' }),
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? 'Publication failed');
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Publication failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8" aria-labelledby="assistant-heading">
      <h2 id="assistant-heading" className="text-lg font-semibold">
        Incident assistant
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Generated interpretations are separate from Incident facts. Check
        citations before using a draft.
      </p>
      {!readOnly && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Ask the assistant</CardTitle>
            <CardDescription>
              Use persisted Signal, Operational Judgment, Policy Decision, and
              Timeline Event evidence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={generate} className="grid max-w-xl gap-4">
              <div className="grid gap-2">
                <Label htmlFor="assistant-kind">Request</Label>
                <NativeSelect
                  id="assistant-kind"
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as AssistantCommand['kind'])
                  }
                >
                  <NativeSelectOption value="summary">
                    Cited summary
                  </NativeSelectOption>
                  <NativeSelectOption value="question">
                    Question and answer
                  </NativeSelectOption>
                  <NativeSelectOption value="hypotheses">
                    Hypotheses
                  </NativeSelectOption>
                  <NativeSelectOption value="status_draft">
                    Status draft
                  </NativeSelectOption>
                </NativeSelect>
              </div>
              {kind === 'question' && (
                <div className="grid gap-2">
                  <Label htmlFor="assistant-question">Question</Label>
                  <Textarea
                    id="assistant-question"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    required
                    maxLength={1000}
                  />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="assistant-key">Operator access key</Label>
                <Input
                  id="assistant-key"
                  type="password"
                  autoComplete="off"
                  value={operatorKey}
                  onChange={(event) => setOperatorKey(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? 'Working…' : 'Generate'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Assistant request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="mt-4 grid gap-4">
        {interactions
          .filter((item) => item.outcome === 'accepted' && item.output)
          .map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <CardTitle className="capitalize">
                  {item.kind.replaceAll('_', ' ')}
                </CardTitle>
                <CardDescription>
                  {item.createdAt} ·{' '}
                  {item.mode === 'recorded'
                    ? 'Recorded response'
                    : 'Live response'}{' '}
                  · {item.returnedModel ?? item.configuredModel}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {item.question && (
                  <p className="text-sm font-medium">{item.question}</p>
                )}
                {item.output!.claims.map((claim, index) => (
                  <p key={index} className="text-sm">
                    {claim.text}{' '}
                    <span className="ml-1 inline-flex flex-wrap gap-1">
                      {claim.citations.map((citation) => (
                        <Badge
                          className="whitespace-normal break-all"
                          key={`${citation.type}:${citation.id}`}
                          variant="secondary"
                          title={citation.id}
                        >
                          {citation.type === 'signal'
                            ? 'Signal'
                            : 'Timeline Event'}{' '}
                          {citation.id}
                        </Badge>
                      ))}
                    </span>
                  </p>
                ))}
                {item.output!.hypotheses.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium">Hypotheses</h3>
                    <ul className="mt-1 list-disc pl-5 text-sm">
                      {item.output!.hypotheses.map((hypothesis, index) => (
                        <li key={index}>{hypothesis}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {item.output!.draft && (
                  <div>
                    <h3 className="text-sm font-medium">
                      Unpublished status draft
                    </h3>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {item.output!.draft.text}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.output!.draft.citations.map((citation) => (
                        <Badge
                          className="whitespace-normal break-all"
                          key={`${citation.type}:${citation.id}`}
                          variant="secondary"
                          title={citation.id}
                        >
                          {citation.type === 'signal'
                            ? 'Signal'
                            : 'Timeline Event'}{' '}
                          {citation.id}
                        </Badge>
                      ))}
                    </div>
                    {!readOnly &&
                      !publishedUpdates.some(
                        (update) => update.assistantInteractionId === item.id,
                      ) && (
                        <Button
                          type="button"
                          className="mt-3"
                          disabled={pending || !operatorKey}
                          onClick={() => void publish(item.id)}
                        >
                          Approve and publish
                        </Button>
                      )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        {interactions.every((item) => item.outcome !== 'accepted') && (
          <p className="text-sm text-muted-foreground">
            No accepted assistant interactions yet.
          </p>
        )}
      </div>
      <h3 className="mt-8 text-base font-semibold">Publication history</h3>
      {publishedUpdates.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          No Published Updates.
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          {publishedUpdates.map((update) => (
            <Card key={update.id}>
              <CardHeader>
                <CardTitle>Published Update</CardTitle>
                <CardDescription>
                  {update.publishedAt} · {update.actor}
                </CardDescription>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm">
                {update.content}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
