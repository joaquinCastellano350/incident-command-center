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
import type { ReevaluationCommand } from '@incident-command-center/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function ReevaluationActions({
  apiBaseUrl,
  triageCaseId,
  questionSetVersion,
  policyVersion,
}: {
  apiBaseUrl: string;
  triageCaseId: string;
  questionSetVersion: string;
  policyVersion: string;
}) {
  const router = useRouter();
  const [operatorKey, setOperatorKey] = useState('');
  const [reason, setReason] = useState('');
  const [additionalEvidence, setAdditionalEvidence] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [newQuestionSet, setNewQuestionSet] = useState('');
  const [newPolicy, setNewPolicy] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const command: ReevaluationCommand = {
      actor: 'demo-operator',
      reason,
      ...(additionalEvidence.trim() ? { additionalEvidence } : {}),
      ...(modelVersion.trim() ? { modelVersion } : {}),
      ...(newQuestionSet
        ? {
            questionSetVersion:
              newQuestionSet as ReevaluationCommand['questionSetVersion'],
          }
        : {}),
      ...(newPolicy
        ? { policyVersion: newPolicy as ReevaluationCommand['policyVersion'] }
        : {}),
    };
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/triage-cases/${triageCaseId}/reevaluations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-operator-key': operatorKey,
          },
          body: JSON.stringify(command),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Re-evaluation request failed');
      }
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Re-evaluation request failed',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Request Re-evaluation</CardTitle>
        <CardDescription>
          Add evidence or select a newer question set, Jev model, or policy.
          Earlier Evaluations and completed actions remain in the audit history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-xl gap-4">
          <div className="grid gap-2">
            <Label htmlFor="reevaluation-key">Operator access key</Label>
            <Input
              id="reevaluation-key"
              type="password"
              autoComplete="off"
              required
              value={operatorKey}
              onChange={(event) => setOperatorKey(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reevaluation-reason">Reason</Label>
            <Input
              id="reevaluation-reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reevaluation-evidence">Additional evidence</Label>
            <Textarea
              id="reevaluation-evidence"
              maxLength={4000}
              value={additionalEvidence}
              onChange={(event) => setAdditionalEvidence(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reevaluation-model">
              Pinned Jev version (optional)
            </Label>
            <Input
              id="reevaluation-model"
              placeholder="jev-1.13.0"
              pattern="jev-[0-9]+\.[0-9]+\.[0-9]+"
              value={modelVersion}
              onChange={(event) => setModelVersion(event.target.value)}
            />
          </div>
          {questionSetVersion === 'northstar-triage.v1' && (
            <div className="grid gap-2">
              <Label htmlFor="reevaluation-questions">Question set</Label>
              <NativeSelect
                id="reevaluation-questions"
                value={newQuestionSet}
                onChange={(event) => setNewQuestionSet(event.target.value)}
              >
                <NativeSelectOption value="">
                  Keep {questionSetVersion}
                </NativeSelectOption>
                <NativeSelectOption value="northstar-triage.v2">
                  northstar-triage.v2 · includes operator evidence
                </NativeSelectOption>
              </NativeSelect>
            </div>
          )}
          {policyVersion === 'northstar-automation.v1' && (
            <div className="grid gap-2">
              <Label htmlFor="reevaluation-policy">Policy</Label>
              <NativeSelect
                id="reevaluation-policy"
                value={newPolicy}
                onChange={(event) => setNewPolicy(event.target.value)}
              >
                <NativeSelectOption value="">
                  Keep {policyVersion}
                </NativeSelectOption>
                <NativeSelectOption value="northstar-automation.v2">
                  northstar-automation.v2 · stronger evidence gate
                </NativeSelectOption>
              </NativeSelect>
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Request failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            type="submit"
            disabled={
              pending ||
              !(
                additionalEvidence.trim() ||
                modelVersion.trim() ||
                newQuestionSet ||
                newPolicy
              )
            }
          >
            {pending ? 'Requesting…' : 'Request Re-evaluation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
