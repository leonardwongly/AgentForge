# Authentication And GitHub Installation Linking

AgentForge supports two dashboard authentication paths:

- Trusted proxy identity for enterprise SSO deployments.
- Built-in GitHub OAuth for self-hosted deployments and local admin setup.

Both paths resolve the same server-side actor shape: login, role, and organization id. State-changing API routes still enforce role and organization authorization at the API boundary.

## Trusted Proxy Auth

Use trusted proxy auth when an ingress, reverse proxy, or identity-aware proxy authenticates users before traffic reaches the dashboard and API.

Required production settings:

```env
AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS=true
AGENTFORGE_API_TRUST_PROXY_HEADERS=true
AGENTFORGE_API_PROXY_SECRET=<shared-hmac-secret>
AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS=true
```

The proxy must strip client-supplied identity headers before injecting:

- `x-agentforge-authenticated-actor`
- `x-agentforge-authenticated-role`
- `x-agentforge-authenticated-organization`

The dashboard signs forwarded identity with `AGENTFORGE_API_PROXY_SECRET` before calling the API. The API rejects stale or invalid signatures.

## Built-In GitHub OAuth

Use built-in GitHub OAuth when the dashboard should authenticate admins directly through the GitHub App OAuth client.

Required settings:

```env
GITHUB_CLIENT_ID=<github-app-oauth-client-id>
GITHUB_CLIENT_SECRET=<github-app-oauth-client-secret>
SESSION_SECRET=<dashboard-session-secret>
AGENTFORGE_API_TRUST_PROXY_HEADERS=true
AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS=true
AGENTFORGE_API_PROXY_SECRET=<shared-hmac-secret>
AGENTFORGE_GITHUB_ADMIN_LOGINS=<comma-separated-admin-logins>
AGENTFORGE_GITHUB_ALLOWED_LOGINS=<comma-separated-non-admin-logins>
AGENTFORGE_DASHBOARD_ORGANIZATION=<agentforge-organization-id>
```

Flow:

1. A user opens `/auth/github/login`.
2. AgentForge sets a signed OAuth state cookie.
3. GitHub redirects back to `/auth/github/callback`.
4. AgentForge exchanges the code server-side, loads the GitHub login, and stores a signed dashboard session cookie.
5. Logins listed in `AGENTFORGE_GITHUB_ADMIN_LOGINS` receive `platform_admin`; logins listed in `AGENTFORGE_GITHUB_ALLOWED_LOGINS` receive `developer`.
6. Unknown GitHub logins are rejected before a dashboard session is created.

Only `platform_admin` and `engineering_manager` can change repository policy/settings. Only `platform_admin` can approve GitHub App installations.

## GitHub App Installation Linking

Installing the GitHub App is not enough to govern repositories. AgentForge records installations as `pending_approval` until a platform admin approves the installation inside Settings.

Flow:

1. Configure `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`.
2. Start the install flow from Settings or Onboarding.
3. GitHub sends an `installation` or `installation_repositories` webhook, or returns to `/github/installations/callback?installation_id=...`.
4. AgentForge records callback installation IDs only after the signed webhook has confirmed the installation, or after a platform admin records the installation ID and account login manually.
5. AgentForge stores the installation as `pending_approval`.
6. A platform admin reviews the account login/type and approves it.
7. AgentForge links the installation to the current AgentForge organization and syncs repositories from stored installation events.

Repository removal events disable and archive the repository record instead of deleting historical records.

Manual fallback:

If the callback is unavailable, use Settings to record the numeric installation ID and account login manually, then approve it as a platform admin.

Production deployments that enable the sample preview must set both `AGENTFORGE_ENABLE_SAMPLE_PREVIEW=true` and `AGENTFORGE_SAMPLE_FIXTURE_ROOT=<absolute-project-root-containing-fixtures>`. Without an explicit fixture root, production sample preview stays disabled instead of probing the deployment filesystem.

## Local Development

For local dashboard setup without GitHub OAuth or a proxy:

```env
AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR=true
AGENTFORGE_DASHBOARD_ACTOR=dashboard-local
AGENTFORGE_DASHBOARD_ROLE=developer
AGENTFORGE_DASHBOARD_ORGANIZATION=org_local
AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true
```

The fallback is explicit-only in every environment and is rejected by config and
preflight checks when `APP_BASE_URL`, `NEXT_PUBLIC_APP_URL`, or `API_BASE_URL`
point outside `localhost`, `127.0.0.1`, or `[::1]`. The default fallback role is
`developer`; set `AGENTFORGE_DASHBOARD_ROLE=platform_admin` or
`engineering_manager` only for local admin smoke tests. Do not use local actor
headers in production or shared staging.
