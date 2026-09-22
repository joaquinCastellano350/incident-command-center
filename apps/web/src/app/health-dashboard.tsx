'use client';

import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Separator } from '#components/ui/separator';
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Database,
  LoaderCircle,
  Server,
  Workflow,
} from 'lucide-react';
import {
  HealthCheckJobSchema,
  HealthStatusSchema,
  type HealthCheckJob,
  type HealthStatus,
} from '@incident-command-center/contracts';
import { useState } from 'react';

interface HealthDashboardProperties {
  apiBaseUrl: string;
  initialHealth: HealthStatus;
}

const components = [
  {
    key: 'api',
    label: 'API',
    description: 'Public REST boundary',
    icon: Server,
  },
  {
    key: 'database',
    label: 'PostgreSQL',
    description: 'State and durable jobs',
    icon: Database,
  },
  {
    key: 'worker',
    label: 'Background worker',
    description: 'Asynchronous processing',
    icon: Workflow,
  },
] as const;

export function HealthDashboard({
  apiBaseUrl,
  initialHealth,
}: HealthDashboardProperties) {
  const [health, setHealth] = useState(initialHealth);
  const [job, setJob] = useState<HealthCheckJob | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshHealth(): Promise<void> {
    const response = await fetch(`${apiBaseUrl}/api/v1/health`);
    setHealth(HealthStatusSchema.parse(await response.json()));
  }

  async function pollJob(id: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${apiBaseUrl}/api/v1/health-jobs/${id}`);
      const currentJob = HealthCheckJobSchema.parse(await response.json());
      setJob(currentJob);
      if (currentJob.status === 'completed') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('The worker did not complete the health check in time.');
  }

  async function submitHealthCheck(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    setJob(null);

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/health-jobs`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('The API could not accept the health check.');
      }
      const submittedJob = HealthCheckJobSchema.parse(await response.json());
      setJob(submittedJob);
      await pollJob(submittedJob.id);
      await refreshHealth();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Health check failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const systemReady = health.status === 'ready';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border bg-card">
            <Activity className="size-4" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">Incident Command Center</p>
            <p className="text-xs text-muted-foreground">Northstar Market</p>
          </div>
        </div>
        <Badge
          variant="outline"
          className={
            systemReady
              ? 'gap-1.5 border-emerald-200 text-emerald-700'
              : 'gap-1.5 border-amber-200 text-amber-700'
          }
        >
          {systemReady ? (
            <CheckCircle2 className="size-3" aria-hidden="true" />
          ) : (
            <CircleAlert className="size-3" aria-hidden="true" />
          )}
          {systemReady ? 'All systems ready' : 'System degraded'}
        </Badge>
      </header>

      <Separator className="my-6" />

      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Current readiness across the API, PostgreSQL, and the background
          worker. Run a durable check to verify the complete processing path.
        </p>
      </section>

      <section
        className="mt-6 grid gap-4 md:grid-cols-3"
        aria-label="Component readiness"
      >
        {components.map(({ key, label, description, icon: Icon }) => {
          const ready = health[key] === 'ready';

          return (
            <Card key={key}>
              <CardHeader>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                  <CardTitle className="text-sm font-medium">{label}</CardTitle>
                </div>
                <CardAction>
                  <Badge
                    variant="outline"
                    className={
                      ready
                        ? 'gap-1.5 border-emerald-200 text-emerald-700'
                        : 'gap-1.5 border-amber-200 text-amber-700'
                    }
                  >
                    <CircleDot className="size-3" aria-hidden="true" />
                    {health[key]}
                  </Badge>
                </CardAction>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          );
        })}
      </section>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Durable round-trip check</CardTitle>
          <CardDescription>
            Submit work through the public API, persist it with pg-boss, process
            it in the worker, and retrieve the completed result.
          </CardDescription>
          <CardAction>
            <Button
              disabled={isSubmitting}
              onClick={submitHealthCheck}
              type="button"
            >
              {isSubmitting && (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              )}
              {isSubmitting ? 'Running check' : 'Run health check'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent aria-live="polite">
          {error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Health check failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : job ? (
            <Alert>
              {job.status === 'completed' ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              )}
              <AlertTitle>
                {job.status === 'completed'
                  ? 'Durable check completed'
                  : 'Health job queued'}
              </AlertTitle>
              <AlertDescription className="space-y-1">
                <p className="font-mono text-xs break-all">{job.id}</p>
                {job.result && <p>{job.result.message}</p>}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <Activity aria-hidden="true" />
              <AlertTitle>Ready to verify</AlertTitle>
              <AlertDescription>
                No health job has been submitted in this browser session.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <footer className="mt-auto pt-8 text-xs text-muted-foreground">
        <Separator className="mb-4" />
        Last checked {new Date(health.checkedAt).toLocaleString()} · Public API{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-foreground">
          /api/v1/health
        </code>
      </footer>
    </main>
  );
}
