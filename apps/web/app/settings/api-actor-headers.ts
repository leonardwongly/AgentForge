import { createHmac } from "node:crypto";
import type { DashboardActorContext } from "./actor-context";

export function apiActorHeaders(actor: DashboardActorContext): Record<string, string> {
  if (process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS !== "true") {
    if (
      process.env.NODE_ENV !== "test" &&
      process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS !== "true"
    ) {
      throw new Error(
        "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true is required before forwarding raw local actor headers to the API."
      );
    }
    return {
      "x-agentforge-actor": actor.login,
      "x-agentforge-role": actor.role,
      "x-agentforge-organization": actor.organizationId
    };
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = process.env.AGENTFORGE_API_PROXY_SECRET;
  if (!secret) {
    throw new Error(
      "AGENTFORGE_API_PROXY_SECRET must be configured before forwarding trusted dashboard identity to the API."
    );
  }
  const signature = createHmac("sha256", secret)
    .update([timestamp, actor.login, actor.role, actor.organizationId].join(":"))
    .digest("hex");

  return {
    "x-agentforge-authenticated-actor": actor.login,
    "x-agentforge-authenticated-role": actor.role,
    "x-agentforge-authenticated-organization": actor.organizationId,
    "x-agentforge-signature-timestamp": timestamp,
    "x-agentforge-signature": signature
  };
}
