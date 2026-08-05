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
    const payload = await requestJson<{ record: { id: string; repositoryId: string } }>(
      actor,
      "/api/policies/preview",
      {
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
      }
    );
    await requestJson(
      actor,
      `/api/repositories/${encodeURIComponent(payload.record.repositoryId)}/policy`,
      {
        method: "PUT",
        body: JSON.stringify({ contentYaml })
      }
    );
    recordId = payload.record.id;
  } catch (error) {
    console.error("Sample policy preview failed", {
      message: error instanceof Error ? error.message : "unknown error"
    });
    redirect("/onboarding?error=sample-preview-failed");
  }

  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  revalidatePath("/records");
  redirect(`/onboarding?updated=sample-preview&recordId=${encodeURIComponent(recordId)}`);
}

function samplePreviewEnabled(): boolean {
  // Available in a deployed instance when explicitly enabled with the flag.
  // AGENTFORGE_SAMPLE_FIXTURE_ROOT is optional: the action falls back to
  // locating the bundled fixtures/ directory automatically.
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  return process.env.AGENTFORGE_ENABLE_SAMPLE_PREVIEW === "true";
}

async function requestJson<T>(
  actor: DashboardActorContext,
  route: string,
  init: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) {
    onAbort();
  } else {
    init.signal?.addEventListener("abort", onAbort, { once: true });
  }
  const response = await fetch(`${apiBaseUrl}${route}`, {
    ...init,
    cache: "no-store",
    signal: controller.signal,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...apiActorHeaders(actor),
      ...(init.headers ?? {})
    }
  }).finally(() => {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", onAbort);
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
  const configuredRoot = process.env.AGENTFORGE_SAMPLE_FIXTURE_ROOT?.trim();
  if (configuredRoot) {
    await access(path.join(configuredRoot, "fixtures"));
    return configuredRoot;
  }
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
