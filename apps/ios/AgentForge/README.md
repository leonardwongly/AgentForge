# AgentForge iOS Client

Native SwiftUI operator client for a deployed AgentForge Merge Guard instance.

## Scope

- Connects to the deployed AgentForge API over HTTPS.
- Fetches `/health` and `/ready`.
- Surfaces database, worker queue, runtime store, queue status, version, and
  production-readiness interpretation.
- Opens GitHub OAuth through the deployed dashboard at `/auth/github/login`.
- Uses SwiftUI, Observation, async/await networking, and iOS 26 Liquid Glass
  surfaces.
- Keeps endpoint validation and readiness interpretation in a local
  `AgentForgeCore` Swift package so it can be tested without requiring a
  booted iOS Simulator.

## Security boundary

The iOS client does not connect directly to Postgres, Redis, MinIO, GitHub
private keys, webhook secrets, OAuth secrets, installation tokens, or any other
server-side infrastructure surface. OAuth code exchange and authorization remain
owned by the deployed AgentForge dashboard/API.

HTTP is accepted only for local development hosts such as `localhost`; deployed
AgentForge URLs must use HTTPS.

## Defaults

- API: `https://agentforge-api-production-5fc1.up.railway.app`
- Dashboard: `https://agentforge-web-production.up.railway.app`

## Build and test

Run from this directory:

```bash
xcodegen generate
swift test --package-path Packages/AgentForgeCore
xcodebuild -project AgentForge.xcodeproj -scheme AgentForge -destination 'generic/platform=iOS Simulator' build
curl -fsS https://agentforge-api-production-5fc1.up.railway.app/health
curl -fsS https://agentforge-api-production-5fc1.up.railway.app/ready
```
