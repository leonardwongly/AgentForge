"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveDashboardActor } from "../../../settings/actor";
import type { DashboardActorContext } from "../../../settings/actor-context";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const maxPolicyBytes = 200_000;

export async function saveRepositoryPolicy(formData: FormData): Promise<void> {
  const repositoryId = readRequiredString(formData, "repositoryId", "Missing repository id.");
  const returnTo = `/repositories/${encodeURIComponent(repositoryId)}/policy`;
  const contentYaml = readPolicyYaml(formData, returnTo);

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/repositories/${encodeURIComponent(repositoryId)}/policy`, {
      method: "PUT",
      body: JSON.stringify({ contentYaml })
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "Repository policy could not be saved."
    );
  }

  revalidatePath(returnTo);
  revalidatePath(`/repositories/${encodeURIComponent(repositoryId)}/policy-preview`);
  revalidatePath("/dashboard");
  redirect(`${returnTo}?updated=policy`);
}

async function requestJson<T = unknown>(
  actor: DashboardActorContext,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...actorHeaders(actor),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return (await response.json()) as T;
}

function actorHeaders(actor: DashboardActorContext): Record<string, string> {
  if (actor.source === "trusted_headers") {
    return {
      "x-agentforge-authenticated-actor": actor.login,
      "x-agentforge-authenticated-role": actor.role
    };
  }
  return {
    "x-agentforge-actor": actor.login,
    "x-agentforge-role": actor.role
  };
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload.error ?? payload.message ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function readPolicyYaml(formData: FormData, returnTo: string): string {
  const value = formData.get("contentYaml");
  if (typeof value !== "string" || value.trim().length === 0) {
    redirectWithError(returnTo, "Policy YAML is required.");
  }
  if (Buffer.byteLength(value, "utf8") > maxPolicyBytes) {
    redirectWithError(returnTo, "Policy YAML must be smaller than 200 KB.");
  }
  return value;
}

function readRequiredString(formData: FormData, key: string, message: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    redirectWithError("/settings", message);
  }
  return value.trim();
}

function redirectWithError(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message.slice(0, 180))}`);
}
