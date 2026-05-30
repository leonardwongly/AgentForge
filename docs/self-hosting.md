# Hardened Self-Hosting Reference

This is the hardened reference for running AgentForge Merge Guard on your own
infrastructure. It documents the production security contract that startup
enforces, the reverse-proxy identity boundary the API depends on, and a go-live
validation checklist.

It complements, and does not replace, the platform-specific topology in
[railway-deployment.md](railway-deployment.md) and the runtime contract in
[runtime-boundaries.md](runtime-boundaries.md). AgentForge v1.0 is self-hosted;
there is no hosted SaaS option.

## Topology

Run these as separate processes/services behind a single ingress:

- `agentforge-api` — Fastify API and GitHub webhook receiver.
- `agentforge-worker` — BullMQ evaluation worker and check publisher.
- `agentforge-web` — Next.js dashboard (optional; can be hosted separately).
- Managed PostgreSQL and Redis (durable runtime mode is required for public
  traffic; see [runtime-boundaries.md](runtime-boundaries.md)).
- An authenticating reverse proxy / ingress in front of the API and dashboard.

The dashboard authenticates the human (built-in GitHub OAuth or your SSO proxy)
and forwards an HMAC-signed actor identity to the API. The reverse proxy's job
is to terminate TLS and to strip spoofable identity headers from external
clients so only the trusted dashboard can assert identity.

## Production configuration contract

When `NODE_ENV=production`, the process fails closed at startup unless all of
the following hold. Set them deliberately; do not relax them to work around a
deployment problem.

| Variable                                   | Required value / note                                             |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `DATABASE_URL`                             | Managed PostgreSQL connection string (no local default applies).  |
| `REDIS_URL`                                | Managed Redis connection string (no local default applies).       |
| `GITHUB_APP_ID`                            | Required, to mint installation tokens and publish checks.         |
| `GITHUB_APP_PRIVATE_KEY`                   | Required, to authenticate as the GitHub App.                      |
| `GITHUB_WEBHOOK_SECRET`                    | Required; webhook signature verification is mandatory.            |
| `ALLOW_UNSIGNED_GITHUB_WEBHOOKS`           | Must be `false`.                                                  |
| `SOURCE_CODE_STORAGE`                      | Must be `false`.                                                  |
| `REDACT_SECRETS`                           | Must be `true`.                                                   |
| `AGENTFORGE_API_TRUST_PROXY_HEADERS`       | Must be `true`.                                                   |
| `AGENTFORGE_API_PROXY_SECRET`              | Required when API proxy trust is on; the dashboard signs with it. |
| `AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS` | Must be `true`.                                                   |
| `AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS`     | Must be `true` (acknowledges the proxy strips spoofable headers). |
| `AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS` | Must be `false`.                                                  |
| `AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR`   | Must be `false`.                                                  |

If you enable built-in GitHub OAuth (set `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET`), then `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
`SESSION_SECRET` are also required. Generate secrets with
`openssl rand -hex 32`.

## Reverse-proxy identity boundary

The API trusts the `x-agentforge-authenticated-*` headers only because the proxy
is expected to remove any client-supplied identity headers before requests reach
the app. Your ingress MUST strip these inbound headers from external traffic so
they cannot be spoofed:

- `x-agentforge-actor`, `x-agentforge-role`, `x-agentforge-organization`
- `x-agentforge-authenticated-actor`, `x-agentforge-authenticated-role`,
  `x-agentforge-authenticated-organization`
- `x-agentforge-signature`, `x-agentforge-signature-timestamp`

The trusted dashboard re-injects signed versions using
`AGENTFORGE_API_PROXY_SECRET`; the API verifies the HMAC-SHA256 signature and a
timestamp within a 5-minute window.

Example with Caddy:

```caddy
api.example.com {
	@stripped header_regexp X-Agentforge .*
	request_header -X-Agentforge-Actor
	request_header -X-Agentforge-Role
	request_header -X-Agentforge-Organization
	request_header -X-Agentforge-Authenticated-Actor
	request_header -X-Agentforge-Authenticated-Role
	request_header -X-Agentforge-Authenticated-Organization
	request_header -X-Agentforge-Signature
	request_header -X-Agentforge-Signature-Timestamp
	reverse_proxy agentforge-api:4000
}
```

With nginx, use `proxy_set_header X-Agentforge-... "";` for each header on the
API location. Confirm with a request that sends a forged
`x-agentforge-authenticated-role: platform_admin`: it must not be honored.

## Data, TLS, and backups

- Terminate TLS at the ingress; do not expose the API, dashboard, Postgres, or
  Redis directly to untrusted networks.
- Require Redis auth/TLS in any shared or networked deployment. The local
  `docker-compose.yml` is loopback-bound and local-only; do not reuse it for
  staging or production.
- Source code and full diffs are not stored by default; keep it that way.
- Back up PostgreSQL (Change Control Records, audit events, installation trust
  state). Audit retention is governed by `AUDIT_RECORD_RETENTION_DAYS`.

## Database and start commands

```sh
pnpm db:deploy   # apply migrations (never `prisma migrate dev` in production)
pnpm start:api
pnpm start:worker
pnpm start:web   # optional dashboard
```

## Go-live validation checklist

- [ ] `NODE_ENV=production` and the process starts without a fail-closed config
      error.
- [ ] `curl -fsS https://<api-host>/health` returns `200` (public liveness).
- [ ] `/ready` returns `200` only with signed operator headers, and
      `401`/`403` without them.
- [ ] `/api/settings` reports `runtimeCapabilities.productionReady: true`.
- [ ] A forged `x-agentforge-authenticated-*` header from an external client is
      stripped and not honored.
- [ ] A test webhook with a valid `x-hub-signature-256` is accepted; an
      unsigned or wrongly-signed webhook is rejected.
- [ ] Redis is reachable and the worker drains the
      `merge-guard-evaluations` queue.
- [ ] PostgreSQL backups are configured and restore-tested.

## Notes

- Optional advisory AI features are off by default and never affect a check or
  decision. The built-in evidence drafter is deterministic and performs no
  network egress.
- For operational launch and rollback steps, see [runbook.md](runbook.md).
