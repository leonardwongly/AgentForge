# Railway Deployment

This guide deploys AgentForge Merge Guard to Railway as a shared monorepo with separate API, worker, and optional web services.

## Target Topology

Use one Railway project and one production environment:

- `agentforge-api`: Fastify API and GitHub webhook receiver.
- `agentforge-worker`: BullMQ worker for PR evaluations and GitHub check publication.
- `agentforge-web`: optional Next.js dashboard. This may also run elsewhere if `APP_BASE_URL` points to that host.
- `Postgres`: backing database for records, policy, settings, exports, and webhook idempotency.
- `Redis`: BullMQ queue backing service.

Keep the API, worker, Postgres, and Redis in the same Railway project so private service networking and reference variables can be used. Expose only the API and web services publicly.

## Build and Start Commands

Configure each code service from the monorepo root. Railway supports custom start commands for shared monorepos.

| Service             | Build command        | Pre-deploy command | Start command       |
| ------------------- | -------------------- | ------------------ | ------------------- |
| `agentforge-api`    | `pnpm railway:build` | `pnpm db:deploy`   | `pnpm start:api`    |
| `agentforge-worker` | `pnpm railway:build` | none               | `pnpm start:worker` |
| `agentforge-web`    | `pnpm railway:build` | none               | `pnpm start:web`    |

Run `pnpm db:deploy` on exactly one service, normally the API service, before that deployment goes live. Do not run `prisma migrate dev` in Railway.

## Required Variables

Set these variables on every code service unless noted otherwise:

```bash
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
GITHUB_APP_ID=<github-app-id>
GITHUB_APP_PRIVATE_KEY=<escaped-pem-or-multiline-secret>
GITHUB_INSTALLATION_ID=<optional-smoke-test-installation-id>
GITHUB_WEBHOOK_SECRET=<same-secret-configured-in-github-app>
ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false
APP_BASE_URL=https://<dashboard-host>
API_BASE_URL=https://<api-host>
DEFAULT_POLICY_MODE=observe
SOURCE_CODE_STORAGE=false
FULL_DIFF_RETENTION=disabled
REDACT_SECRETS=true
LLM_FEATURES=false
SESSION_SECRET=<random-32-byte-or-longer-secret>
AGENTFORGE_API_TRUST_PROXY_HEADERS=false
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=false
AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=false
AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=false
```

Only set `AGENTFORGE_API_TRUST_PROXY_HEADERS=true` or `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true` after the deployed ingress strips spoofed `x-agentforge-*` and `x-agentforge-authenticated-*` headers before injecting trusted identity headers.

Use Railway shared variables for duplicated non-public values when practical. Avoid printing `railway variable list --json` or `railway variable list --kv` output in logs because those modes include raw secret values.

## CLI Setup

The local machine can use the Railway CLI through `npx`:

```bash
npx --yes @railway/cli login --browserless
npx --yes @railway/cli init --name agentforge --json
npx --yes @railway/cli add --database postgres --json
npx --yes @railway/cli add --database redis --json
npx --yes @railway/cli add --service agentforge-api --json
npx --yes @railway/cli add --service agentforge-worker --json
npx --yes @railway/cli add --service agentforge-web --json
```

If the project already exists, use:

```bash
npx --yes @railway/cli link <project-id>
npx --yes @railway/cli service list --json
```

Set non-secret variables with `railway variable set`. Set secrets through the Railway dashboard or via stdin so shell history does not capture values:

```bash
npx --yes @railway/cli variable set NODE_ENV=production --service agentforge-api --skip-deploys
printf '%s' "$GITHUB_APP_PRIVATE_KEY" | npx --yes @railway/cli variable set GITHUB_APP_PRIVATE_KEY --stdin --service agentforge-api --skip-deploys
```

Repeat shared runtime variables for `agentforge-worker` and `agentforge-web`.

## Deploy

Generate a public Railway domain for the API service:

```bash
npx --yes @railway/cli domain --service agentforge-api --port 4000 --json
```

Set `API_BASE_URL` to the generated API URL and set `APP_BASE_URL` to the dashboard URL. Then deploy each service:

```bash
npx --yes @railway/cli up --service agentforge-api --environment production --message "deploy api"
npx --yes @railway/cli up --service agentforge-worker --environment production --message "deploy worker"
npx --yes @railway/cli up --service agentforge-web --environment production --message "deploy web"
```

For detached deploys, use `--detach --json`, then poll:

```bash
npx --yes @railway/cli deployment list --service agentforge-api --environment production --json
npx --yes @railway/cli logs --service agentforge-api --environment production
```

## Validation

After deployment:

```bash
curl -fsS "$API_BASE_URL/health"
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id> --publish-check
```

Update the GitHub App webhook URL only after the API health check passes:

```text
https://<api-host>/webhooks/github
```

Then use GitHub App settings to send a ping delivery or edit a test PR. Confirm:

- GitHub reports a `2xx` webhook delivery.
- `WebhookDelivery` records are written once per delivery ID.
- The worker consumes the queued evaluation.
- The `AgentForge Merge Guard` check run is published on the test PR.
- Logs do not expose private keys, webhook secrets, source patches, or installation tokens.

## Rollback

If the API or worker deployment fails before migrations run, roll back the failed Railway deployment. If `pnpm db:deploy` applied a migration, use a database restore or a reviewed backward migration before rolling back code that is not schema-compatible.

If webhook delivery breaks after cutover, point the GitHub App webhook URL back to the previous known-good endpoint, keep `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false`, and inspect Railway API logs plus `WebhookDelivery` rows before retrying.
