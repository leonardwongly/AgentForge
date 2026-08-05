# Cloudflare Deployment Guide

AgentForge is self-hosted. This guide shows how to expose and operate it with
**Cloudflare** — the fastest path to a secure, publicly reachable webhook
receiver and dashboard without opening inbound ports or standing up your own
load balancer.

Two complementary options:

1. **Cloudflare Tunnel** (recommended) — `cloudflared` opens an outbound-only
   connection to Cloudflare's edge and routes your hostname to the local
   services. No inbound firewall rules or public IPs required.
2. **Cloudflare Pages** (optional) — serve the Next.js dashboard from the edge
   with `@cloudflare/next-on-pages`. The API, worker, Postgres, and Redis stay
   self-hosted.

---

## 1. Cloudflare Tunnel (API + worker + dashboard)

### 1.1 Prerequisites

- A Cloudflare account with a zone (domain) you control.
- `cloudflared` installed, or Docker (the included compose file runs it in a
  container).
- The AgentForge services running locally on `127.0.0.1` (API `:4000`, web
  `:3000`) or on the host network.

### 1.2 Create the tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create agentforge
cloudflared tunnel route dns agentforge <your-hostname>
cloudflared tunnel route dns agentforge api.<your-hostname>
```

### 1.3 Configure and run

Edit `deploy/cloudflare/tunnel/config.yml` to set your tunnel name, credentials
path, and hostnames, then run:

```bash
docker compose -f deploy/cloudflare/tunnel/docker-compose.yml up -d
```

The tunnel exposes:

| Public host | Local service |
| ----------- | ------------- |
| `https://<your-hostname>` | Dashboard (web `:3000`) |
| `https://api.<your-hostname>` | API + webhook receiver (`:4000`) |

### 1.4 Configure AgentForge

Set the public URLs and the GitHub webhook URL:

```env
APP_BASE_URL=https://<your-hostname>
API_BASE_URL=https://api.<your-hostname>
GITHUB_WEBHOOK_SECRET=<secret>
```

In GitHub, set the webhook URL to:

```text
https://api.<your-hostname>/webhooks/github
```

### 1.5 Security notes

- Cloudflare terminates TLS at the edge; the tunnel is encrypted end-to-end.
- Keep the fail-closed production posture enabled (`NODE_ENV=production`).
- Use trusted-proxy identity or built-in GitHub OAuth for the dashboard.
- Optionally add Cloudflare WAF rules to rate-limit `/webhooks/github`.

---

## 2. Cloudflare Pages (optional dashboard)

Serve the Next.js dashboard from Cloudflare's edge:

```bash
pnpm --filter @agentforge/web build
npx @cloudflare/next-on-pages
npx wrangler pages deploy .vercel/output/static
```

`deploy/cloudflare/pages/wrangler.toml` sets `API_BASE_URL` to your tunneled API
hostname. The API, worker, Postgres, and Redis remain self-hosted.

> Note: the dashboard uses Next.js server actions and calls the API; it is not
> a static-only export. Use `@cloudflare/next-on-pages`/OpenNext, and confirm
> the features you rely on are supported before promoting this path.

---

## 3. When to use which

- **Tunnel** — simplest, works with the full stack, recommended for most
  self-hosted deployments.
- **Pages** — use only if you specifically want the dashboard served from
  Cloudflare's edge and can accept the OpenNext compatibility constraints.
- **Helm / Terraform** — for Kubernetes or AWS-native deployments, see
  `deploy/helm/agentforge` and `deploy/terraform/aws`.
