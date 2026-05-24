# Contributing

Thanks for improving AgentForge Merge Guard. This repository is security-sensitive because it processes GitHub webhooks, governance policy, audit records, and deployment secrets. Keep changes small, reviewable, tested, and aligned with the existing TypeScript, Prisma, Fastify, Next.js, and Vitest patterns.

## Development Setup

```bash
corepack enable
corepack prepare pnpm@11.1.1 --activate
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio
pnpm prisma:validate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Local endpoints:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:4000`
- Webhook receiver: `http://localhost:4000/webhooks/github`

## Before Opening a Pull Request

Run the smallest relevant checks while developing, then run the broader checks before review:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm fixtures:run
pnpm prisma:validate
```

For DB-backed and browser-facing changes, also run:

```bash
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm test:integration
pnpm test:e2e:preflight
pnpm test:e2e
```

## Pull Request Expectations

- Explain what changed, why it changed, and how it was tested.
- Include regression tests for bug fixes and policy/auth/security behavior changes.
- Keep public behavior backward-compatible unless a breaking change is intentional and documented.
- Do not commit secrets, `.env` files, local metadata, logs, generated reports, browser traces, or build artifacts.
- Update docs, examples, environment variables, migrations, and runbooks when behavior or operations change.

## Security Review Checklist

- Validate untrusted input at API, webhook, policy, file, and form boundaries.
- Preserve tenant and organization authorization checks.
- Keep secrets out of logs, dashboard display, check output, exports, and prompts.
- Avoid new dependencies unless they are justified, maintained, pinned through the lockfile, and compatible with Apache-2.0 distribution.
- Add abuse and negative tests for auth bypass, malformed payloads, oversized input, path traversal, injection, and replay scenarios when relevant.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0.
