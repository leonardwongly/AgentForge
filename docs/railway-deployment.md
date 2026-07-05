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
AGENTFORGE_API_TRUST_PROXY_HEADERS=true
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=false
AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true
AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=false
AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS=true
AGENTFORGE_API_PROXY_SECRET=<random-32-byte-or-longer-shared-secret>
```

Production startup intentionally fails when trusted proxy identity and header
stripping are not enabled. The values above are valid only behind ingress that
strips spoofed `x-agentforge-*` and `x-agentforge-authenticated-*` headers
before injecting trusted `x-agentforge-authenticated-actor`,
`x-agentforge-authenticated-role`, `x-agentforge-authenticated-organization`,
`x-agentforge-signature-timestamp`, and `x-agentforge-signature` headers.

For a private local smoke deployment without a stripping auth proxy, keep
`NODE_ENV=development`, keep both `*_TRUST_PROXY_HEADERS=false`, and do not use
that environment for public webhook or dashboard traffic.

Use Railway shared variables for duplicated non-public values when practical. Avoid printing `railway variable list --json` or `railway variable list --kv` output in logs because those modes include raw secret values.

## Tenant Isolation: Provision a Non-Superuser Database Role

Railway's managed Postgres `DATABASE_URL` connects as the database owner role,
which is superuser-equivalent. Postgres Row-Level Security is **silently
bypassed for superusers and roles with `BYPASSRLS`**, so pointing `DATABASE_URL`
directly at Railway's default connection string leaves the tenant-isolation RLS
backstop described in [docs/tenant-isolation-rls.md](tenant-isolation-rls.md)
completely inert, with no error at startup. This is an active step operators
must take; it is not the default.

Connect to the Railway Postgres service (`railway connect Postgres`, or use the
connection details from the Postgres service's Variables tab) and run:

```sql
CREATE ROLE agentforge_app WITH LOGIN PASSWORD '<strong-password>'
  NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO agentforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentforge_app;
GRANT EXECUTE ON FUNCTION agentforge_current_org() TO agentforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agentforge_app;
```

Run this after `pnpm db:deploy` has applied the `20260616080000_tenant_rls`
migration (that migration creates `agentforge_current_org()` and the `public`
schema tables the grants above target); re-running `GRANT ... ON ALL TABLES`
after later migrations add tables is safe and idempotent.

Then split `DATABASE_URL` by service:

- Leave the `agentforge-api` **pre-deploy** command (`pnpm db:deploy`) using
  Railway's default owner-role `DATABASE_URL`, since applying migrations
  requires elevated privileges.
- Set the **runtime** `DATABASE_URL` for `agentforge-api` and
  `agentforge-worker` to a connection string using `agentforge_app` and the
  password chosen above, keeping the same host/port/database from Railway's
  Postgres service (for example
  `postgresql://agentforge_app:<strong-password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`).

At startup, `assertOrgIsolationEnforced` (exported from `@agentforge/db`, see
[docs/tenant-isolation-rls.md](tenant-isolation-rls.md#runtime-enforcement-assertorgisolationenforced))
queries the connected role and throws in production if it still bypasses RLS —
confirm `agentforge-api` and `agentforge-worker` logs show a clean startup
(no `Unsafe AgentForge production configuration` error) after switching
`DATABASE_URL` to `agentforge_app`.

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
curl -fsS "$API_BASE_URL/ready" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: auditor" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>"
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id> --publish-check
```

Verify the auth proxy stripping rule before enabling dashboard mutations from a
public host. A spoofed local actor header must not grant access:

```bash
curl -i "$API_BASE_URL/api/settings" \
  -H "x-agentforge-actor: attacker" \
  -H "x-agentforge-role: platform_admin" \
  -H "x-agentforge-organization: org_local"
```

Also verify spoofed authenticated identity headers fail without a valid proxy
signature:

```bash
curl -i "$API_BASE_URL/api/settings" \
  -H "x-agentforge-authenticated-actor: attacker" \
  -H "x-agentforge-authenticated-role: platform_admin" \
  -H "x-agentforge-authenticated-organization: org_local"
```

The expected result for both requests is `401` or `403`. If either request
succeeds, do not cut over traffic; fix ingress header stripping and proxy
signature enforcement before setting the GitHub App webhook URL.

Poll authenticated `/ready` with retry/backoff until it returns success. Do not
update the GitHub App webhook URL until `/health`, authenticated `/ready`, and
the GitHub smoke checks pass; `/ready` proves Redis/BullMQ are reachable before
webhook traffic is cut over:

```text
https://<api-host>/webhooks/github
```

Then use GitHub App settings to send a ping delivery or edit a test PR. Confirm:

- GitHub reports a `2xx` webhook delivery.
- `WebhookDelivery` records are written once per delivery ID.
- Authenticated `/ready` reports the Redis-backed worker queue as ready. If
  Redis is configured but unavailable, `/ready` returns `not_ready` while
  `/health` remains available for safe load-balancer checks.
- The worker consumes the queued evaluation.
- The `AgentForge Merge Guard` check run is published on the test PR.
- Logs do not expose private keys, webhook secrets, source patches, or installation tokens.

## Rollback

If the API or worker deployment fails before migrations run, roll back the failed Railway deployment. If `pnpm db:deploy` applied a migration, use a database restore or a reviewed backward migration before rolling back code that is not schema-compatible.

If webhook delivery breaks after cutover, point the GitHub App webhook URL back to the previous known-good endpoint, keep `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false`, and inspect Railway API logs plus `WebhookDelivery` rows before retrying.

For queue incidents, use the admin queue API before shelling into Redis. In
production, these headers should be injected by the trusted auth proxy with
`AGENTFORGE_API_TRUST_PROXY_HEADERS=true`; do not use local actor headers on
public deployments:

```bash
curl -fsS "$API_BASE_URL/api/admin/queue" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: platform_admin" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>"
```

Replay a specific stored webhook delivery only after confirming the failure is
safe to reprocess:

```bash
curl -fsS -X POST "$API_BASE_URL/api/admin/queue/replay" \
  -H "content-type: application/json" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: platform_admin" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>" \
  --data '{"deliveryId":"<github-delivery-id>"}'
```
