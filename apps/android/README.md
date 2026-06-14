# AgentForge Android Client

Native Android operator client for a deployed AgentForge Merge Guard instance.

## Scope

- Connects to the deployed AgentForge API over HTTPS.
- Fetches `/health` and `/ready`.
- Surfaces database, worker queue, runtime store, queue status, version, and
  production-readiness interpretation.
- Opens GitHub OAuth through the deployed dashboard at `/auth/github/login`
  using Android Custom Tabs.

## Security boundary

The Android client does not connect directly to Postgres, Redis, MinIO, GitHub
private keys, webhook secrets, OAuth secrets, installation tokens, or any other
server-side infrastructure surface. OAuth code exchange and authorization remain
owned by the deployed AgentForge dashboard/API.

HTTP is accepted only for local development hosts such as `10.0.2.2`; deployed
AgentForge URLs must use HTTPS.

## Defaults

- API: `https://agentforge-api-production-5fc1.up.railway.app`
- Dashboard: `https://agentforge-web-production.up.railway.app`

## Build and test

Run from this directory:

```bash
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

The debug APK is emitted under `app/build/outputs/apk/debug/`.
