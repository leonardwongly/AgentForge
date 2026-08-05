import { headers } from "next/headers";
import { cache } from "react";
import {
  dashboardActorErrorMessage,
  resolveDashboardActorContext,
  type DashboardActorContext
} from "./actor-context";

// React cache is scoped to each Next server request: parallel loaders share one
// signature claim, while later requests still pass through replay protection.
export const resolveDashboardActor = cache(async (): Promise<DashboardActorContext> => {
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
});
