FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/testing/package.json packages/testing/package.json

RUN npm ci

COPY . .

ENV API_INTERNAL_BASE_URL=http://api:3001
ENV PUBLIC_API_BASE_URL=http://localhost:3001

RUN npm run typecheck && npm run build --workspace @incident-command-center/web

ENV NODE_ENV=production

EXPOSE 3000 3001
