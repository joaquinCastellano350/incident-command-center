# Incident Command Center

> A decision-first incident operations platform where Jev makes bounded semantic judgments, software policy authorizes actions, and a generative LLM helps operators understand cited evidence.

## Status

This document is the authoritative product and architecture specification for the portfolio MVP. The design was agreed on September 20, 2026.

Supporting documents:

- [Domain glossary](./CONTEXT.md)
- [Evaluation plan](./docs/EVALUATION.md)
- [Delivery plan](./docs/DELIVERY.md)
- [Canonical scenarios](./docs/SCENARIOS.md)
- [Architecture decision records](./docs/adr/README.md)

## Purpose

The project primarily demonstrates how to choose and integrate an AI model for bounded operational decisions. In particular, it tests whether Jev is a better fit than deterministic rules or a conventional structured-output generative LLM for incident triage judgments.

The project also demonstrates practical incident-management knowledge: priority, ownership, evidence correlation, incident matching, human review, paging, audit history, and failure handling.

The claim is not that a cheaper model is automatically better, that AI replaces incident commanders, or that a portfolio benchmark proves production safety. The claim must be supported by measured quality, calibration, latency, cost, schema reliability, and safe automation coverage.

## Core principles

1. **Jev judges meaning.** It converts unstructured operational evidence into narrow, typed judgments and probability information.
2. **Software owns authority.** Versioned policy decides whether any operational action is allowed.
3. **Workflows own effects.** Idempotent workflow handlers create incidents, link evidence, assign owners, page engineers, and create review tasks.
4. **Humans control uncertain or harmful outcomes.** Operators can supersede automation without erasing its history.
5. **The generative LLM has no operational authority.** It summarizes cited evidence, answers questions, and drafts communications.
6. **Every consequential step is inspectable.** Inputs, model metadata, judgments, policy rules, attempts, outcomes, and overrides are retained.

## Operating environment

The MVP serves **Northstar Market**, a fictional marketplace operating in three logical regions: `us-east`, `eu-west`, and `sa-east`.

| Domain           | Owned services                                                             |
| ---------------- | -------------------------------------------------------------------------- |
| `payments`       | `checkout-api`, `payment-processor`                                        |
| `authentication` | `identity-api`, `session-service`                                          |
| `fulfillment`    | `order-service`, `fulfillment-worker`                                      |
| `platform`       | `api-gateway`, `event-router`, shared databases and runtime infrastructure |

The organization, priority rubric, ownership map, correlation windows, and automation policy are fixed, versioned configuration. Multi-tenancy and configuration administration are outside the MVP.

## Domain flow

```text
Provider payload
      |
      v
    Signal ------------------------------+
      |                                  |
      v                                  |
 Triage Case                             |
      |                                  |
      v                                  |
  Evaluation (Jev)                       |
      |                                  |
      v                                  |
 Policy Decision                         |
      |                                  |
      +------------+---------------------+
      |            |                     |
      v            v                     v
Workflow Action  Review Task          Audit history
      |            |
      +------+-----+
             v
          Incident
             |
             v
   Timeline + Evidence Links
```

Every normalized Signal creates exactly one Triage Case. A Triage Case does not imply that an Incident exists. It resolves as one of:

- `incident_created`
- `evidence_linked`
- `dismissed`
- `awaiting_review`

Evaluation and workflow failures are processing conditions, not business outcomes. They remain retryable or require operational intervention.

## Signal ingestion

The MVP accepts four source types:

| Source           | Structured source facts                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| Monitoring Alert | Metric, threshold, observed value, service, region, evaluation window            |
| Customer Report  | Subject, message, customer reference, affected operation, reported time          |
| Log Anomaly      | Service, region, error signature, occurrence count, sample messages, time window |
| Deployment Event | Service, region, version, commit reference, deployer, outcome, completion time   |

Every Signal has a common envelope containing:

- stable Signal ID and provider source reference;
- provider and source-event deduplication key;
- source type;
- occurrence and receipt timestamps;
- service, environment, and region when known;
- title and human-readable content;
- structured source-specific facts;
- normalization schema version;
- immutable raw-fixture reference; and
- ingestion and correlation metadata.

Unknown fields remain explicitly unknown. Adapters preserve source-specific structure instead of flattening every input into a prose prompt. Seeded scenarios enter through the same adapter interfaces as webhook payloads.

## Jev evaluation

### Input state

One normal Evaluation request contains:

- the normalized Signal;
- the versioned Northstar Market taxonomy and judgment criteria;
- relevant deterministic correlation facts; and
- at most five candidate Incident summaries.

Candidate Incidents are retrieved before the request using PostgreSQL filters, full-text search, trigram similarity, identifiers, service, region, and recency. Retrieval considers active Incidents plus Incidents resolved within the previous 24 hours.

### Operational judgments

Jev answers independent, typed questions over the shared state:

| Judgment              | Shape                | Outcomes                                                                  |
| --------------------- | -------------------- | ------------------------------------------------------------------------- |
| Priority Assessment   | Choice               | `P0`, `P1`, `P2`, `P3`                                                    |
| Customer Reach        | Choice               | `single`, `subset`, `widespread`, `unknown`                               |
| Regional Reach        | Choice               | `single_region`, `multi_region`, `global`, `not_applicable`, `unknown`    |
| Service Breadth       | Choice               | `single_service`, `multi_service`, `platform_wide`, `unknown`             |
| Primary Owning Domain | Choice               | `payments`, `authentication`, `fulfillment`, `platform`, `unknown`        |
| Evidence Sufficiency  | Noul                 | Probability that the Signal contains enough evidence for automated triage |
| Incident Match        | Choice per candidate | `same_incident`, `related_distinct`, `unrelated`                          |

`platform` is a real ownership domain, not a fallback for uncertainty. `unknown` ownership requires review.

No Jev question recommends or authorizes a Workflow Action. Whether no candidate matches is a policy conclusion after all candidate judgments, not a model label.

### Priority rubric

| Priority      | Meaning                                                                              | Expected response                           |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| P0 - Critical | Catastrophic or rapidly expanding impact requiring immediate cross-team coordination | Page owning on-call and Incident Commander  |
| P1 - Major    | Substantial customer or service impact requiring immediate owning-team response      | Page owning on-call                         |
| P2 - Moderate | Limited degradation with tolerable short-term impact or a viable workaround          | Create and assign without automatic paging  |
| P3 - Minor    | Small, informational, or unconfirmed impact that does not justify urgent response    | Review or dismiss; never page automatically |

A Priority Assessment is historical model output. Current Priority is the single authoritative value operators see and use. A Human Override changes Current Priority while retaining the original assessment in the audit history.

### Provider metadata

Each Evaluation records:

- internal Evaluation and attempt IDs;
- TypeSafe request ID;
- configured and returned model names;
- normalization, decision-schema, question-set, and policy versions;
- input and output token usage;
- local wall-clock latency;
- retry count;
- normalized terminal outcome; and
- the full typed answers and probability information.

Evaluation and deployed profiles use explicit versioned Jev model names when available. `latest` aliases are development-only. Application-level deadlines bound SDK retries.

An explicit Re-evaluation appends a new linked Evaluation. It never edits the previous result or pretends that earlier Workflow Actions did not occur.

## Policy and automation

Policy consumes reusable Operational Judgments, deterministic facts, and action-specific risk rules. It does not calculate one global confidence score.

| Action               | Required inputs                                                                         |
| -------------------- | --------------------------------------------------------------------------------------- |
| Create Incident      | Priority Assessment, impact dimensions, Evidence Sufficiency                            |
| Assign owner         | Primary Owning Domain                                                                   |
| Page on-call         | P0/P1 Current Priority, Primary Owning Domain, Evidence Sufficiency, Corroborating Fact |
| Create Evidence Link | Incident Match, Evidence Sufficiency                                                    |
| Request review       | Missing prerequisite, unknown outcome, conflict, or threshold failure                   |

An uncertain judgment blocks only the actions that depend on it. For example, uncertain priority does not prevent a high-confidence Evidence Link.

### Corroborating facts

Automatic paging requires at least one machine-verifiable Corroborating Fact:

- a declared Monitoring Alert threshold breach;
- at least three independent correlated Signals;
- a Deployment Event correlated with a service regression; or
- an already-confirmed P0 Incident.

One Customer Report cannot automatically page anyone.

Versioned correlation policy uses:

- 15 minutes for a deployment on the same service and region;
- at least three independent Signals within 10 minutes;
- two hours of recent activity for active Incident retrieval;
- 24 hours for resolved Incident retrieval; and
- distinct customer references to establish independent Customer Reports.

### Human-only actions

Automation may create an open Incident, assign an owner, page an engineer, or create an Evidence Link. It may never automatically:

- suppress or downgrade an Incident;
- acknowledge, mitigate, resolve, or reopen an Incident; or
- publish generated communications.

Human Overrides are append-only records containing the replacement outcome, actor, timestamp, and reason.

### Review queue

Review Urgency is deterministic:

- **Urgent:** plausible P0/P1 impact, a Corroborating Fact, or a failed high-impact Workflow Action; target review within five minutes.
- **Standard:** other ambiguous or incomplete cases; target review within four business hours.

The queue sorts by urgency and then oldest receipt time. Jev does not produce a separate review-priority judgment.

## Incident lifecycle

```text
open -> acknowledged -> mitigated -> resolved
  ^                                  |
  +------------- reopened -----------+
```

Automation may only create an `open` Incident. Humans control every later transition. Each transition is an immutable Timeline Event. The domain behavior is tested, but the complete lifecycle is not a featured part of the demo.

Late evidence may link to an Incident resolved within the 24-hour lookback, but policy also creates a Review Task and never reopens it automatically.

## Generative incident assistant

GPT-5.6 Terra powers the assistant through a provider adapter. The assistant may:

- summarize an Incident timeline;
- answer questions using allowlisted persisted evidence;
- explain observable judgments and the explicit policy path;
- draft a status update; and
- propose clearly labeled investigation hypotheses.

It may not claim to reveal Jev's internal reasoning, mutate operational state, invoke Workflow Actions, or treat generated text as Incident truth.

Assistant output is structured into evidence-backed claims with Signal or Timeline Event IDs and a separate hypothesis field. The application validates every cited identifier against the supplied evidence and rejects or regenerates invalid output.

Each Assistant Interaction retains its evidence references, provider and model version, request metadata, and generated output. A human must explicitly publish a draft before it becomes a Published Update.

## Architecture

The MVP is a modular monolith with separately runnable web/API and worker processes:

```text
Simulated providers / scenario runner
                 |
                 v
        Fastify ingestion API
                 |
       PostgreSQL + pg-boss
                 |
                 v
        Background worker
   +-------------+-------------+
   |             |             |
   v             v             v
Retrieval   Jev adapter   Policy engine
   |             |             |
   +-------------+-------------+
                 |
                 v
          Workflow module
                 |
     +-----------+-----------+
     |                       |
     v                       v
Incident/audit records   Simulated providers
     |
     v
Next.js dashboard + assistant
```

Internal modules are:

- ingestion and normalization;
- triage and candidate retrieval;
- Jev Evaluation;
- policy;
- workflows and provider adapters;
- incidents, evidence, and timeline;
- human review;
- assistant access; and
- benchmark evaluation.

Modules communicate through explicit domain interfaces and versioned contracts. They are not independently deployed microservices.

## Technology

The TypeScript monorepo contains:

- `apps/web`: Next.js operator dashboard;
- `apps/api`: Fastify HTTP and Server-Sent Events API;
- `apps/worker`: asynchronous Evaluation and workflow processing;
- `packages/domain`: framework-independent domain behavior;
- `packages/contracts`: schemas and versioned event contracts; and
- `packages/testing`: fixtures, scenario builders, and benchmark utilities.

PostgreSQL is the transactional system of record. `pg-boss`, hidden behind an internal job port, provides durable jobs using the same database transaction as state changes. Redis, a separate message broker, GraphQL, WebSockets, vector databases, and Kubernetes are excluded from the MVP.

REST handles commands and queries. Server-Sent Events deliver Evaluation, review, and Workflow Action updates, with polling as a reconnect fallback.

## Reliability

The system promises at-least-once delivery with idempotent effects, not exactly-once execution.

- Provider and source-event keys deduplicate Signals.
- One Triage Case exists per Signal.
- Policy Decisions have stable versioned identities.
- Workflow Actions have idempotency keys and an effects ledger.
- State changes and outgoing work are committed transactionally.
- Retries reuse the same action idempotency key.

Every Workflow Action retains Action Attempts while its current state moves through:

```text
pending -> executing -> succeeded
                  +-> retry_scheduled -> executing
                  +-> permanently_failed
```

A permanent failure creates an urgent operator notification. It does not roll back an earlier successful effect; for example, a failed page does not delete an Incident that was already created.

If Jev fails, the worker records the failed Evaluation, retries with bounded backoff, and creates a Review Task after exhaustion. It never silently substitutes the generative LLM or deterministic heuristics for Jev. Ordinary monitoring and paging remain independent safety systems.

## Persistence and audit

The system uses relational current-state tables plus append-only history. It is not fully event-sourced.

Current state and its corresponding Evaluation, Policy Decision, Human Override, Workflow Action, Action Attempt, or Timeline Event are written within the same transaction where applicable.

A correlation ID connects Signal ingestion, Evaluation, Policy Decision, Workflow Action, and Timeline Event data across structured logs, traces, metrics, and dashboard views.

## Operator experience

The dashboard has four primary views:

1. **Triage Queue:** incoming and review-required Triage Cases.
2. **Triage Case Detail:** Signal, judgments, distributions, policy rule, action, attempts, and overrides.
3. **Incident Detail:** Current Priority, owner, Evidence Links, Timeline Events, and assistant.
4. **Evaluation Lab:** comparison among Jev, GPT-5.6 Terra, and deterministic rules.

The public synthetic workspace uses a stable `demo-operator`. Mutating and model-triggering operations require lightweight access control and are rate- and quota-limited. Read-only exploration may remain public.

The product exposes queue delay, processing time, model latency and failures, judgment distributions, review rate, policy selection, action attempts, and idempotency suppression without requiring access to a separate observability vendor.

## Evaluation

The benchmark contains roughly 150 versioned synthetic cases covering ordinary, ambiguous, contradictory, incomplete, near-duplicate, adversarial, and counterfactual inputs. Entire scenario families are split between development and held-out evaluation.

Humans approve all gold judgments and permitted actions. A generative LLM may draft scenario prose but cannot establish benchmark truth.

Jev, GPT-5.6 Terra, and deterministic rules receive equivalent normalized facts, taxonomy, and semantic criteria. The primary metric is safe automation coverage subject to these held-out targets:

- zero observed false pages;
- at least 95% precision for automatic Incident creation;
- at least 97% precision for automatic Evidence Links; and
- a Corroborating Fact for every automatic page.

The report also includes judgment quality, calibration, review rate, schema failures, retries, latency, token usage, estimated cost, and uncertainty intervals. An action that misses its error constraint remains human-reviewed.

The full methodology is defined in [docs/EVALUATION.md](./docs/EVALUATION.md).

## Data and security boundaries

- The portfolio uses synthetic operational data only.
- Model credentials remain server-side.
- Normalization redacts configured sensitive fields.
- Each model receives only the fields required for its task.
- Source text is treated as untrusted data.
- The assistant accesses only allowlisted persisted evidence.
- The assistant has no direct database or Workflow Action authority.
- Public model calls are protected by quotas and rate limits.

## Deployment and execution modes

The application supports one-command local startup through Docker Compose and a public managed-container deployment with managed PostgreSQL. API and worker processes use the same versioned image with different commands.

Two prominently labeled model modes are supported:

- **Live mode:** calls real Jev and GPT-5.6 Terra APIs.
- **Recorded mode:** replays captured provider responses through the same adapters for deterministic presentations and outage recovery.

Recorded results must never be represented as fresh model output. Routine tests use fakes. The public product defaults to live mode within its configured quota.

The active public demonstration targets less than US$30 per month and may sleep, scale down, or be archived when not in use.

## Canonical demonstration

The eight-to-ten-minute demonstration shows:

1. a `checkout-api` deployment followed by an 18% payment authorization failure rate against a 2% threshold in `us-east`;
2. a P1 Priority Assessment and automatic Incident creation, payments assignment, and paging based on corroborated evidence;
3. three independent Customer Reports linked to the existing Incident without duplicate creation or paging;
4. a vague authentication report routed to human review and dismissed with a recorded reason;
5. the end-to-end decision trace and idempotency record;
6. a citation-validated summary and status draft; and
7. the Evaluation Lab comparison.

An optional trust drill replays a provider event to prove idempotency and simulates Jev unavailability to prove safe failure behavior.

Detailed fixtures are defined in [docs/SCENARIOS.md](./docs/SCENARIOS.md).

## Non-goals

- Production monitoring, ticketing, or paging integrations.
- Autonomous remediation.
- Automatic suppression, resolution, or reopening.
- Multi-tenancy or taxonomy administration.
- Enterprise authentication or full role-based access control.
- A complete incident-response lifecycle interface.
- Embedding search or a vector database.
- Independently deployed microservices or Kubernetes.
- Model training or fine-tuning.
- Production-safety or universal-superiority claims.

## Definition of done

A fresh reviewer can start the application locally with one documented command, run the seeded scenarios through provider adapters, inspect all judgments and policy decisions, observe both automated and reviewed outcomes, replay inputs without duplicate effects, generate cited assistant output, inspect benchmark results, access the controlled public deployment, and run the required automated tests successfully.

The detailed timebox, release gates, documentation requirements, budget, and presentation plan are defined in [docs/DELIVERY.md](./docs/DELIVERY.md).
