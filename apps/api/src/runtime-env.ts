import type { AgentForgeConfig } from "@agentforge/config";

export function hydrateApiAuthEnvironment(config: AgentForgeConfig): void {
  setDefaultEnv("AGENTFORGE_API_TRUST_PROXY_HEADERS", String(config.auth.apiTrustProxyHeaders));
  setDefaultEnv(
    "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
    String(config.auth.apiAllowLocalActorHeaders)
  );
  setDefaultEnv("AGENTFORGE_API_PROXY_SECRET", config.auth.apiProxySecret);
}

function setDefaultEnv(key: string, value: string | undefined): void {
  if (value !== undefined && process.env[key] === undefined) {
    process.env[key] = value;
  }
}
