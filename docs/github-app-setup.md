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

Private key setup:

1. Generate a private key in GitHub App settings.
2. Store the PEM in a secret manager for production.
3. For local development, place the escaped PEM in `GITHUB_APP_PRIVATE_KEY`.

Do not commit GitHub private keys, webhook secrets, OAuth secrets, tokens, or installation tokens.
