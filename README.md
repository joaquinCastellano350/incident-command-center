# Incident Command Center

Incident Command Center is a decision-first incident operations platform for the fictional Northstar Market organization. This initial vertical slice proves that the browser, REST API, PostgreSQL-backed durable queue, and background worker run as one observable modular monolith.

## Run locally

Prerequisites:

- Node.js 22.12 or newer
- Docker Desktop with Docker Compose v2

Start the complete application with one command:

```sh
npm run dev
```

Docker Compose starts the dashboard, API, worker, and PostgreSQL. Open [http://localhost:3000](http://localhost:3000) and select **Run health check**. The public health query is available at [http://localhost:3001/api/v1/health](http://localhost:3001/api/v1/health).

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
