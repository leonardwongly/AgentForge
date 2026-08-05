# syntax=docker/dockerfile:1
# AgentForge multi-stage build for the API, worker, and web dashboard.
# Build a specific target: `docker build --target api|worker|web -t agentforge:<name> .`
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN pnpm fetch

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm db:generate
RUN pnpm build

FROM build AS api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "start:api"]

FROM build AS worker
ENV NODE_ENV=production
CMD ["pnpm", "start:worker"]

FROM build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start:web"]
