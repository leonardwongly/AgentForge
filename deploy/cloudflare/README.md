# Cloudflare deployment for AgentForge Merge Guard.

#

# AgentForge is self-hosted. Cloudflare provides two complementary ways to

# expose and operate it without opening inbound ports on your host:

#

# 1. **Cloudflare Tunnel** (recommended for the API + worker + dashboard) —

# `cloudflared` opens an outbound-only connection to Cloudflare's edge and

# routes your public hostname to the local services. No inbound firewall

# rules or public IPs are required. This is the fastest path to a secure,

# publicly reachable webhook receiver and dashboard.

#

# 2. **Cloudflare Pages** (optional for the Next.js dashboard) — via

# `@cloudflare/next-on-pages` / OpenNext. Use this when you want the

# dashboard served from Cloudflare's edge. The API and worker still run

# self-hosted (they require Node, Postgres, and Redis).

#

# See docs/cloudflare-deployment.md for the full walkthrough.

## Cloudflare Tunnel

The `tunnel/` directory contains a `cloudflared` configuration that exposes:

- `https://<host>/` -> dashboard (web, :3000)
- `https://<host>/api/*` -> API (:4000)
- `https://<host>/webhooks/*` -> API webhook receiver (:4000)

Run it with Docker Compose (see tunnel/docker-compose.yml):

```bash
cloudflared tunnel login
cloudflared tunnel create agentforge
docker compose -f deploy/cloudflare/tunnel/docker-compose.yml up -d
```

## Cloudflare Pages (optional dashboard)

`pages/wrangler.toml` is a starting point for serving the dashboard from
Cloudflare Pages with `@cloudflare/next-on-pages`. The dashboard calls the API
at `API_BASE_URL`, so point it at your tunneled API hostname. The API, worker,
Postgres, and Redis remain self-hosted.
