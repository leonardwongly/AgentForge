# Security Policy

AgentForge Merge Guard handles GitHub webhook payloads, repository metadata, policy results, evidence, reviewer routing, and audit exports. Treat deployment credentials, GitHub App private keys, webhook secrets, OAuth client secrets, session secrets, queue credentials, database credentials, and export storage credentials as sensitive.

## Supported Versions

Security fixes are accepted against the `main` branch until a versioned release policy is published. Public releases should tag the commit and describe any supported upgrade path in the release notes.

## Reporting a Vulnerability

Do not open a public GitHub issue for a suspected vulnerability.

Report privately by using GitHub private vulnerability reporting if it is enabled on the repository. If it is not enabled, email me@leonardwong.tech with the subject prefix `[AgentForge Security]`.

Include:

- Affected commit, tag, or deployment version.
- Reproduction steps and expected impact.
- Whether secrets, credentials, source code, audit records, or tenant data may be exposed.
- Any logs or screenshots with secrets and personal data redacted.

## Security Expectations

- Keep `ALLOW_UNSIGNED_GITHUB_WEBHOOKS=false` outside local fixture replay.
- Keep `SOURCE_CODE_STORAGE=false` and `REDACT_SECRETS=true` unless a deployment has an approved data-retention plan.
- Configure `SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, and `AGENTFORGE_API_PROXY_SECRET` through a secret manager or protected environment variables.
- Use trusted proxy identity headers only behind ingress that strips spoofable client-supplied identity headers.
- Rotate GitHub App keys and OAuth credentials after suspected exposure.
- Run `pnpm audit --audit-level moderate`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `gitleaks detect --source . --redact --config .gitleaks.toml` before release.

## Scope

In scope:

- Authentication and authorization bypasses.
- Webhook signature verification bypasses.
- Cross-tenant data access.
- Secrets or source-code leakage through logs, exports, dashboard views, check output, or prompts.
- Injection, SSRF, path traversal, unsafe deserialization, or unsafe shell execution in repository, webhook, policy, and export paths.
- Supply-chain issues that compromise build or runtime integrity.

Out of scope:

- Vulnerabilities in third-party services not caused by AgentForge.
- Social engineering or physical attacks.
- Denial-of-service reports without a realistic abuse path.
- Issues requiring already-compromised deployment secrets without privilege escalation.
