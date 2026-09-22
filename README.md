# Incident Command Center

Incident Command Center is a decision-first incident operations platform for the fictional Northstar Market organization. This initial vertical slice proves that the browser, REST API, PostgreSQL-backed durable queue, and background worker run as one observable modular monolith.

## Run locally

Prerequisites:

- Node.js 22.12 or newer
- Docker Desktop with Docker Compose v2

Set `TYPESAFE_API_KEY` in your environment, then start the complete application:

```sh
npm run dev
```

Docker Compose starts the dashboard, API, worker, and PostgreSQL. Open [http://localhost:3000](http://localhost:3000) and select **Run health check**. The public health query is available at [http://localhost:3001/api/v1/health](http://localhost:3001/api/v1/health).

The worker defaults to **live** Jev mode with the pinned `jev-1.13.0` model. Set `EVALUATION_MODE=recorded` to replay local fixtures. The checked-in synthetic responses cover the canonical checkout deployment and the subsequent `checkout-api` payment failure alert at 18 against a threshold of 2, with no candidate Incident. An unrecorded input produces a failed Evaluation and an urgent Review Task; fixtures are never presented as fresh model answers. `RECORDED_JEV_RESPONSE_FILE` can point to one JSON recording or an array with expected Signal facts, candidate IDs, request ID, and response body. Replace the synthetic fixtures with captured responses before using recorded mode to demonstrate actual prior Jev results. `JEV_MODEL` may override the pinned version in development. Credentials stay in the worker. The Triage Case view labels every Evaluation by mode and shows its typed probabilities and audit metadata. When candidate Incidents are found, the Operator reviews the match before a new Incident can be created; automatic match thresholds await the held-out benchmark.

Run the opt-in live provider contract smoke test with `LIVE_JEV_SMOKE=1` and `TYPESAFE_API_KEY` set: `npx vitest run tests/smoke/jev-live.test.ts`. Ordinary tests use deterministic or recorded adapters and do not call TypeSafe.

Stop the application with `npm run dev:down`. To also remove the local database volume, use `npm run dev:reset`.

## Quality

Run formatting checks, TypeScript validation, and the complete PostgreSQL health-job test with:

```sh
npm run quality
```

The command starts the PostgreSQL dependency when needed. The integration test submits work through the public REST boundary, executes it with a real pg-boss worker, and reads the completed result through the public query.

## Boundaries

- `apps/web`: browser-visible Next.js health experience
- `apps/api`: Fastify public REST adapter
- `apps/worker`: separately runnable background worker
- `packages/contracts`: versioned public schemas
- `packages/domain`: framework-independent clock and provider ports
- `packages/application`: application-facing ports
- `packages/adapters`: PostgreSQL and pg-boss implementations
- `packages/testing`: deterministic clock and replaceable provider test support

Configuration is validated with Zod at process startup. Database credentials remain in the API and worker environments; the browser receives only the public API base URL.
