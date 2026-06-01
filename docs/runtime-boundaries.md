# Runtime Boundaries

AgentForge has two runtime modes. The distinction is intentional and visible in
`/ready`, `/api/settings`, and `/metrics`. `/health` is intentionally minimal so
public load balancers can probe process liveness without learning backend state.

## Local In-Memory Mode

In-memory mode is for local demos, fixture previews, and fast tests.

- Change Control Records, audit events, export jobs, owner mappings, repository
  settings, queued evaluations, and webhook delivery ids live only in process
  memory.
- Webhook delivery duplicate detection is best-effort and is lost when the API
  process restarts.
- Manual GitHub installation approval is disabled because installation trust
  state must be durable.
- Queue-backed worker retry behavior is not exercised unless `REDIS_URL` is
  configured.
- This mode is not production-ready and should not receive public GitHub
  webhook traffic.

## Durable Runtime Mode

Durable mode is required for public or shared deployments.

- Postgres is the source of truth for organizations, repository settings,
  GitHub installation approval state, webhook delivery lifecycle, evaluations,
  Change Control Records, audit events, and export jobs.
- Redis/BullMQ is the source of truth for queued evaluation delivery, retry
  attempts, backoff, failed-job inspection, and worker handoff.
- Webhook delivery status moves through `received`, `queued`, `processing`,
  `completed`, `enqueue_failed`, or `failed`, making enqueue failures
  recoverable and replayable.
- `/ready` reports `not_ready` when Redis is configured but unavailable, while
  `/health` remains safe for process liveness checks.
- In production, `/ready` and `/metrics` require signed proxy actor context from
  a `platform_admin`, `engineering_manager`, or `auditor`; unauthenticated
  requests receive `401` and lower-privilege actors receive `403`.

## Capability Contract

`/api/settings` exposes `runtimeCapabilities` so the dashboard and operators do
not infer durable behavior from environment variables alone:

- `durableRecords`: Postgres-backed records and settings are active.
- `durableWebhookReplay`: webhook delivery lifecycle rows are replayable.
- `manualGitHubInstallationApproval`: platform admins can approve/link GitHub
  installations.
- `queueBackedEvaluations`: Redis/BullMQ is configured for evaluation jobs.
- `productionReady`: both durable records and queue-backed evaluations are
  configured.

## Validation

Use these checks after setup or deployment:

```bash
curl -fsS "$API_BASE_URL/health"
curl -fsS "$API_BASE_URL/ready" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: auditor" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>"
curl -fsS "$API_BASE_URL/api/settings" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: platform_admin" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>"
curl -fsS "$API_BASE_URL/metrics" \
  -H "x-agentforge-authenticated-actor: <operator-login>" \
  -H "x-agentforge-authenticated-role: auditor" \
  -H "x-agentforge-authenticated-organization: <organization-id>" \
  -H "x-agentforge-signature-timestamp: <unix-seconds>" \
  -H "x-agentforge-signature: <proxy-signature>"
```

For public deployments, `runtimeCapabilities.productionReady` should be `true`,
`/ready` should return `200`, and `/metrics` should expose queue, webhook,
record, check-run, export, audit-action, and GitHub App configuration gauges
without secrets.
