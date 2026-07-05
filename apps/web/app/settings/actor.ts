import { headers } from "next/headers";
import {
  dashboardActorErrorMessage,
  resolveDashboardActorContext,
  type DashboardActorContext
} from "./actor-context";

export async function resolveDashboardActor(): Promise<DashboardActorContext> {
  let requestHeaders: Awaited<ReturnType<typeof headers>> | undefined;
  try {
    requestHeaders = await headers();
  } catch {
    requestHeaders = undefined;
  }
  const actor = await resolveDashboardActorContext({
    headers: requestHeaders,
    env: process.env,
    nodeEnv: process.env.NODE_ENV
  });
  if (!actor) {
    throw new Error(dashboardActorErrorMessage());
  }
  return actor;
}
