# GitHub App Setup

Create a GitHub App for local or production use.

Required webhook events:

- `pull_request`
- `pull_request_review`
- `check_suite`
- `check_run`
- `push`
- `repository`
- `installation`
- `installation_repositories`

Minimum permissions:

- Pull requests: read/write
- Checks: read/write
- Contents: read
- Metadata: read
- Issues: read/write if PR-visible notes are enabled
- Members: read for GitHub-verified team reviewer approvals

The worker uses the installation credentials to fetch PR files, reviews, commits, and supported manifest contents before evaluating deterministic policy. It also publishes the `AgentForge Merge Guard` check run back to GitHub. Branch protection should require that check only after the repository has graduated to `enforce` or `optimize`.

Team reviewer requirements are cleared only after GitHub confirms that the approving user is an active member of the required team slug. Missing `Members: read`, unavailable membership APIs, or inactive memberships fail closed and leave the team reviewer requirement pending.

The Settings and Onboarding pages expose routing diagnostics for this path. When team owner mappings exist, the diagnostics call out that `Members: read` must be granted before team approvals can clear enforce-mode checks. Reviewer requirements also retain the routing reason and team-verification failure so a blocked PR shows whether the pending state came from a missing approval, missing permission, or failed membership lookup.

CODEOWNERS preview is available through:

```bash
curl -sS \
  -H "content-type: application/json" \
  -d '{"content":"* @org/platform-team\n/src/billing/** @org/billing-owner","changedPaths":["src/billing/checkout.ts"]}' \
  http://localhost:4000/api/codeowners/preview
```

The preview uses last-match-wins CODEOWNERS precedence, normalizes `@org/team` to `org/team`, and reports unsupported negated patterns as diagnostics instead of silently treating them as owner routes.

Webhook URL:

```text
https://<api-host>/webhooks/github
```

Local development:

```bash
pnpm dev:api
ngrok http 4000
```

Set the webhook URL to the tunnel URL plus `/webhooks/github`. Generate a webhook secret, save it in GitHub, and set `GITHUB_WEBHOOK_SECRET` in `.env`.

Webhook signature verification fails closed by default. If `GITHUB_WEBHOOK_SECRET` is missing, AgentForge rejects webhook deliveries unless `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true` is explicitly set for local fixture replay. Do not enable unsigned webhook mode on shared or deployed endpoints.

Read-only GitHub App smoke test:

```bash
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
```

The smoke command creates an installation token, fetches the PR through GitHub App credentials, evaluates the built-in fintech policy, and prints only metadata counts. It does not publish a check run unless `--publish-check` is passed. Use `--publish-check` only against a test PR after confirming the app has `Checks: read/write`.

Private key setup:

1. Generate a private key in GitHub App settings.
2. Store the PEM in a secret manager for production.
3. For local development, place the escaped PEM in `GITHUB_APP_PRIVATE_KEY`.

Do not commit GitHub private keys, webhook secrets, OAuth secrets, tokens, or installation tokens.
