# MVP Delivery

## Timebox

Plan for six weeks at roughly 10–15 hours per week:

1. Domain model, contracts, and ingestion.
2. Jev Evaluation and policy.
3. Workflow reliability and human review.
4. Operator dashboard and generative assistant.
5. Benchmark and baseline comparison.
6. Deployment, documentation, and demo polish.

Work that threatens the core end-to-end path moves outside the MVP.

## Release gates

A release requires:

- unit tests for domain transitions and policy rules;
- table-driven tests for every Workflow Action gate;
- property-based tests for safety and replay invariants;
- schema-contract tests for adapters and versioned events;
- PostgreSQL integration tests for transactions, jobs, retries, and concurrency;
- end-to-end seeded scenarios through provider adapters;
- assistant citation-validation tests; and
- a small opt-in smoke Evaluation against the real model APIs.

The full benchmark reports quality separately and does not make routine CI depend on external model availability.

## Operating budget

Target less than US$30 per month while the public demonstration is active. Prefer services that sleep or scale down, enforce strict model-call quotas and rate limits, serve precomputed benchmark results to ordinary visitors, restrict live benchmark execution to the maintainer, and allow the deployment to be shut down or archived when inactive. Track each provider's cost separately.

## Non-goals

- Production monitoring, ticketing, or paging integrations.
- Autonomous remediation.
- Automatic Incident suppression, resolution, or reopening.
- Multi-tenancy or taxonomy administration.
- Enterprise authentication or full role-based access control.
- A complete incident-response lifecycle interface.
- Vector databases or embeddings.
- Independently deployed microservices or Kubernetes.
- Model training or fine-tuning.
- Claims of production safety or universal model superiority.

## Definition of done

A fresh reviewer can start the system with one documented command, load deterministic scenarios, observe ingestion through durable asynchronous processing, inspect Jev's typed judgments and probabilities, identify the exact policy rule and version, and observe automatic creation, evidence linking, paging, or human review. The reviewer can override a result without erasing history, replay inputs without duplicate effects, generate a citation-validated summary or status draft, inspect precomputed benchmark results, access a controlled public deployment, and run the required automated tests successfully.

## Demonstration

The primary demonstration lasts eight to ten minutes:

1. State the architectural thesis.
2. Run a corroborated P0 or P1 scenario and show automatic Incident creation and paging.
3. Run related reports and show Evidence Links.
4. Run a vague report and complete its Human Override.
5. Inspect the decision trace and idempotency record.
6. Generate a cited incident summary and status draft.
7. Compare Jev, GPT-5.6 Terra, and deterministic rules in the Evaluation Lab.
8. Close with limitations and non-goals.

An optional trust drill replays the same provider event to demonstrate idempotency and simulates Jev unavailability to demonstrate bounded retries followed by human review without generative-model substitution. The trust drill remains separate so an external provider outage cannot derail the primary demo.

The application supports two prominently labeled execution modes. Live mode calls the configured Jev and GPT-5.6 Terra APIs within quota. Recorded mode replays captured provider responses through the same adapters for deterministic presentations and outage recovery. Tests use fakes, the public product defaults to live mode, and no recorded result may be represented as fresh model output.

## Documentation

Ship a concise README and one-command setup, architecture and decision-flow diagrams, the canonical glossary and indexed ADRs, versioned event and API contracts, the policy matrix and priority rubric, benchmark methodology and report, threat model and data-flow boundaries, an operational runbook for reset and failure simulation, a recorded demo video, representative screenshots, and explicit limitations and extension points.

Generated benchmark artifacts identify the code revision, corpus version, model versions, question-set version, and policy version.
