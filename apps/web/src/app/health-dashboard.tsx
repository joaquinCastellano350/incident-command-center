'use client';

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
  ['api', 'API'],
  ['database', 'PostgreSQL'],
  ['worker', 'Background worker'],
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

  return (
    <main>
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">
          IC
        </div>
        <div>
          <p className="eyebrow">Northstar Market</p>
          <p className="brand-name">Incident Command Center</p>
        </div>
        <div className={`overall-status ${health.status}`}>
          <span aria-hidden="true" />
          {health.status === 'ready' ? 'All systems ready' : 'System degraded'}
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow accent">SYSTEM READINESS</p>
        <h1>The operational path is live.</h1>
        <p className="lede">
          Verify the API, durable PostgreSQL queue, and worker as one observable
          system. A health job crosses the same process boundary later Signals
          will use.
        </p>
      </section>

      <section className="component-grid" aria-label="Component readiness">
        {components.map(([key, label]) => (
          <article className="component-card" key={key}>
            <div className="component-heading">
              <p>{label}</p>
              <span className={`status-dot ${health[key]}`} />
            </div>
            <strong>{health[key]}</strong>
            <small>
              {key === 'api' && 'Public REST boundary'}
              {key === 'database' && 'State and durable jobs'}
              {key === 'worker' && 'Asynchronous processing'}
            </small>
          </article>
        ))}
      </section>

      <section className="verification-panel">
        <div>
          <p className="eyebrow">DURABLE ROUND TRIP</p>
          <h2>Send work across the complete system</h2>
          <p>
            The API persists and enqueues a job atomically. The worker completes
            it in a separate process and the result returns through the public
            query.
          </p>
        </div>
        <button
          disabled={isSubmitting}
          onClick={submitHealthCheck}
          type="button"
        >
          {isSubmitting ? 'Checking…' : 'Run health check'}
        </button>

        <div className="job-console" aria-live="polite">
          {!job && !error && (
            <span className="muted">
              No health job submitted in this session.
            </span>
          )}
          {job && (
            <>
              <div>
                <span>Job</span>
                <code>{job.id}</code>
              </div>
              <div>
                <span>Status</span>
                <strong className={job.status}>{job.status}</strong>
              </div>
              {job.result && (
                <div>
                  <span>Result</span>
                  <strong>{job.result.message}</strong>
                </div>
              )}
            </>
          )}
          {error && <strong className="error">{error}</strong>}
        </div>
      </section>

      <footer>
        Last checked {new Date(health.checkedAt).toLocaleString()} · Public API{' '}
        <code>/api/v1/health</code>
      </footer>
    </main>
  );
}
