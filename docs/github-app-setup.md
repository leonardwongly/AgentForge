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

The preview uses last-match-wins CODEOWNERS precedence, preserves ownerless override rules, normalizes `@org/team` to `org/team`, skips email owners that cannot become GitHub reviewer routes, and reports unsupported negated patterns, unsupported bracket patterns, unsupported escaped leading-`#` patterns, missing `@` owner prefixes, and malformed owners as diagnostics instead of silently treating them as owner routes.

Webhook URL:

```text
https://<api-host>/webhooks/github
```

Dashboard setup URL:

```text
https://<dashboard-host>/github/installations/callback
```

Set `GITHUB_APP_SLUG` so the Settings and Onboarding pages can open the GitHub App installation flow. After GitHub redirects back with `installation_id`, AgentForge records the installation as `pending_approval`. A platform admin must approve the installation in Settings before repositories from that installation can be governed.

If the callback cannot be used, run AgentForge with the Postgres runtime store, record the numeric installation ID manually in Settings with the installation account login, then approve it as a platform admin. Manual installation approval is disabled for the in-memory local sample runtime because installation trust state must be durable.

Local development with Cloudflare Tunnel:

```bash
pnpm dev:api
cloudflared tunnel --url http://localhost:4000
```

Set the webhook URL to the tunnel URL plus `/webhooks/github`, for example
`https://<random>.trycloudflare.com/webhooks/github`. Keep the dashboard callback
local unless the dashboard is also tunneled:

```text
http://localhost:3000/github/installations/callback
```

Generate a webhook secret, save it in GitHub, and set `GITHUB_WEBHOOK_SECRET` in
`.env`. For a complete local installation smoke run, also set:

```env
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000
GITHUB_APP_ID=<numeric-app-id>
GITHUB_APP_PRIVATE_KEY=<escaped-or-multiline-pem>
GITHUB_APP_SLUG=<github-app-slug>
GITHUB_CLIENT_ID=<oauth-client-id>
GITHUB_CLIENT_SECRET=<oauth-client-secret>
GITHUB_INSTALLATION_ID=<numeric-installation-id-for-smoke>
SESSION_SECRET=<random-session-secret>
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true
AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true
AGENTFORGE_DASHBOARD_ROLE=platform_admin
```

Install the app on a disposable repository first. The callback records the
installation as `pending_approval`; approve it in Settings as a platform admin
before treating the installation as trusted.

Webhook signature verification fails closed by default. If `GITHUB_WEBHOOK_SECRET` is missing, AgentForge rejects webhook deliveries unless `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=true` is explicitly set for local fixture replay. Do not enable unsigned webhook mode on shared or deployed endpoints.

Read-only GitHub App smoke test:

```bash
pnpm github:smoke --owner <owner> --repo <repo> --pull <number> --installation-id <installation-id>
```

The smoke command creates an installation token, fetches the PR through GitHub App credentials, evaluates the built-in fintech policy, and prints only metadata counts. It does not publish a check run unless `--publish-check` is passed. Use `--publish-check` only against a test PR after confirming the app has `Checks: read/write`.

Disposable public-path validation should pass all of these gates before release:

1. GitHub OAuth sign-in returns to Settings without exposing credentials.
2. GitHub App install link opens the expected app installation page.
3. Installation callback records the returned installation as `pending_approval`.
4. Platform-admin approval marks the installation trusted and syncs repositories.
5. A signed webhook delivery reaches `/webhooks/github` through Cloudflare Tunnel.
6. `pnpm github:smoke ...` fetches the disposable pull request without printing source or tokens.
7. `pnpm github:smoke ... --publish-check` publishes an `AgentForge Merge Guard` check run on the disposable pull request.

Private key setup:

1. Generate a private key in GitHub App settings.
2. Store the PEM in a secret manager for production.
3. For local development, place the escaped PEM in `GITHUB_APP_PRIVATE_KEY`.

Do not commit GitHub private keys, webhook secrets, OAuth secrets, tokens, or installation tokens.

See [auth.md](auth.md) for trusted proxy auth, built-in GitHub OAuth, and installation approval details.
