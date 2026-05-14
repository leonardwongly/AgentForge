import { headers } from "next/headers";
import {
  dashboardActorErrorMessage,
  resolveDashboardActorContext,
  type DashboardActorContext
} from "./actor-context";

export async function resolveDashboardActor(): Promise<DashboardActorContext> {
  const requestHeaders = await headers();
  const actor = resolveDashboardActorContext({
    headers: requestHeaders,
    env: process.env,
    nodeEnv: process.env.NODE_ENV
  });
  if (!actor) {
    throw new Error(dashboardActorErrorMessage());
  }
  return actor;
}
