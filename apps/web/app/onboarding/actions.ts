"use server";

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiActorHeaders } from "../settings/api-actor-headers";
import { resolveDashboardActor } from "../settings/actor";
import type { DashboardActorContext } from "../settings/actor-context";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

export async function runSamplePolicyPreview(): Promise<void> {
  if (!samplePreviewEnabled()) {
    redirect("/onboarding?error=sample-preview-disabled");
  }

  let recordId: string;
  try {
    const actor = await resolveDashboardActor();
    const [pr, contentYaml] = await Promise.all([
      readFixtureJson<Record<string, unknown>>("repos/billing-path.json"),
      readFixtureText("policies/fintech.yaml")
    ]);
    const payload = await requestJson<{ record: { id: string } }>(actor, "/api/policies/preview", {
      method: "POST",
      body: JSON.stringify({
        contentYaml,
        persist: true,
        pr: {
          ...pr,
          repositoryFullName: "acme/first-run-payments",
          pullRequestNumber: 101
        }
      })
    });
    recordId = payload.record.id;
  } catch (error) {
    void error;
    redirect("/onboarding?error=sample-preview-failed");
  }

  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  revalidatePath("/records");
  redirect(`/onboarding?updated=sample-preview&recordId=${encodeURIComponent(recordId)}`);
}

function samplePreviewEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" || process.env.AGENTFORGE_ENABLE_SAMPLE_PREVIEW === "true"
  );
}

async function requestJson<T>(
  actor: DashboardActorContext,
  route: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...apiActorHeaders(actor),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return (await response.json()) as T;
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload.error ?? payload.message ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function readFixtureJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFixtureText(relativePath)) as T;
}

async function readFixtureText(relativePath: string): Promise<string> {
  const root = await findRepositoryRoot();
  return readFile(path.join(root, "fixtures", relativePath), "utf8");
}

async function findRepositoryRoot(): Promise<string> {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../..")
  ];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "fixtures"));
      await access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      // Try the next likely workspace root.
    }
  }
  throw new Error("AgentForge repository root could not be resolved.");
}
