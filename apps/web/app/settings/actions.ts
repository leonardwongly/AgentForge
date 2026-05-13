"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveDashboardActor } from "./actor";
import type { DashboardActorContext } from "./actor-context";

type PolicyModeChoice = "observe" | "warn" | "enforce";
type FullDiffRetentionChoice = "disabled" | "7d" | "30d" | "custom";

type RepositorySettingsPatch = {
  enabled?: boolean;
  mode?: PolicyModeChoice;
  dataHandling?: {
    sourceCodeStorage?: boolean;
    fullDiffRetention?: FullDiffRetentionChoice;
    redactSecrets?: boolean;
    llmFeatures?: boolean;
    auditRecordRetentionDays?: number;
  };
  ownerMappings?: Array<{
    ownerKey: string;
    reviewer: string;
    reviewerType: "user" | "team";
  }>;
};

type RepositoryDataHandlingPatch = NonNullable<RepositorySettingsPatch["dataHandling"]>;

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const allowedReturnPaths = new Set(["/settings", "/onboarding"]);
const policyModes = new Set(["observe", "warn", "enforce"]);
const diffRetentionModes = new Set(["disabled", "7d", "30d", "custom"]);
const reviewerTypes = new Set(["user", "team"]);
const ownerKeyPattern = /^[a-z0-9_-]+$/u;
const reviewerPattern = /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/u;

export async function saveRepositorySettings(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/settings");
  const repositoryId = readString(formData, "repositoryId");
  if (!repositoryId) {
    redirectWithError(returnTo, "Select a repository before saving settings.");
  }

  const mode = readEnumChoice(formData, "mode", policyModes, returnTo, "Repository mode") as
    | PolicyModeChoice
    | undefined;
  const fullDiffRetention = readEnumChoice(
    formData,
    "fullDiffRetention",
    diffRetentionModes,
    returnTo,
    "Full diff retention"
  ) as FullDiffRetentionChoice | undefined;
  const sourceCodeStorage = readBooleanChoice(
    formData,
    "sourceCodeStorage",
    returnTo,
    "Source code storage"
  );
  const redactSecrets = readBooleanChoice(formData, "redactSecrets", returnTo, "Secret redaction");
  const llmFeatures = readBooleanChoice(formData, "llmFeatures", returnTo, "LLM advisory features");
  const enabled = readBooleanChoice(formData, "enabled", returnTo, "Repository status");
  const auditRecordRetentionDays = readPositiveInteger(
    formData,
    "auditRecordRetentionDays",
    returnTo,
    "Audit record retention days"
  );
  const ownerMappings = readOwnerMappings(formData, returnTo);
  const policyPackId = readString(formData, "policyPackId");

  const dataHandling: RepositoryDataHandlingPatch = {};
  if (sourceCodeStorage !== undefined) {
    dataHandling.sourceCodeStorage = sourceCodeStorage;
  }
  if (fullDiffRetention) {
    dataHandling.fullDiffRetention = fullDiffRetention;
  }
  if (redactSecrets !== undefined) {
    dataHandling.redactSecrets = redactSecrets;
  }
  if (llmFeatures !== undefined) {
    dataHandling.llmFeatures = llmFeatures;
  }
  if (auditRecordRetentionDays !== undefined) {
    dataHandling.auditRecordRetentionDays = auditRecordRetentionDays;
  }

  try {
    const actor = await resolveDashboardActor();
    if (policyPackId) {
      const pack = await requestJson<{ contentYaml?: string }>(
        actor,
        `/api/policy-packs/${encodeURIComponent(policyPackId)}`
      );
      if (!pack.contentYaml) {
        throw new Error("Selected policy pack does not include policy YAML.");
      }
      await requestJson(actor, `/api/repositories/${encodeURIComponent(repositoryId)}/policy`, {
        method: "PUT",
        body: JSON.stringify({ contentYaml: pack.contentYaml })
      });
    }

    const patch: RepositorySettingsPatch = {};
    if (enabled !== undefined) {
      patch.enabled = enabled;
    }
    if (mode) {
      patch.mode = mode as NonNullable<RepositorySettingsPatch["mode"]>;
    }
    if (Object.keys(dataHandling).length > 0) {
      patch.dataHandling = dataHandling;
    }
    if (ownerMappings) {
      patch.ownerMappings = ownerMappings;
    }

    await requestJson(actor, `/api/repositories/${encodeURIComponent(repositoryId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "Repository settings could not be saved."
    );
  }

  revalidatePath("/settings");
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  redirect(`${returnTo}?updated=repository-settings`);
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
      "x-agentforge-actor": actor.login,
      "x-agentforge-role": actor.role,
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

function readOwnerMappings(
  formData: FormData,
  returnTo: string
): RepositorySettingsPatch["ownerMappings"] | undefined {
  const rawCount = readString(formData, "ownerMappingRowCount");
  if (!rawCount) {
    return undefined;
  }
  const rowCount = Number.parseInt(rawCount, 10);
  if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 20) {
    redirectWithError(returnTo, "Owner mapping rows are invalid.");
  }

  const ownerMappings: NonNullable<RepositorySettingsPatch["ownerMappings"]> = [];
  const seenOwnerKeys = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    const ownerKey = normalizeOwnerKey(readString(formData, `ownerKey_${index}`));
    const reviewer = readString(formData, `reviewer_${index}`);
    const reviewerType = readEnumChoice(
      formData,
      `reviewerType_${index}`,
      reviewerTypes,
      returnTo,
      "Reviewer type"
    );
    if (!ownerKey && !reviewer) {
      continue;
    }
    if (!ownerKey || !reviewer || !reviewerType) {
      redirectWithError(returnTo, "Each owner mapping must include owner key, reviewer, and type.");
    }
    if (!ownerKeyPattern.test(ownerKey)) {
      redirectWithError(
        returnTo,
        "Owner keys may include only lowercase letters, numbers, underscores, and hyphens."
      );
    }
    if (!reviewerPattern.test(reviewer)) {
      redirectWithError(returnTo, "Reviewer values must be GitHub users or teams.");
    }
    if (seenOwnerKeys.has(ownerKey)) {
      redirectWithError(returnTo, "Owner mapping keys must be unique per repository.");
    }
    seenOwnerKeys.add(ownerKey);
    ownerMappings.push({
      ownerKey,
      reviewer,
      reviewerType: reviewerType as "user" | "team"
    });
  }
  return ownerMappings;
}

function readString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readEnumChoice(
  formData: FormData,
  key: string,
  allowed: Set<string>,
  returnTo: string,
  label: string
): string | undefined {
  const value = readString(formData, key);
  if (!value) {
    return undefined;
  }
  if (!allowed.has(value)) {
    redirectWithError(returnTo, `${label} is invalid.`);
  }
  return value;
}

function readBooleanChoice(
  formData: FormData,
  key: string,
  returnTo: string,
  label: string
): boolean | undefined {
  const value = readString(formData, key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value) {
    redirectWithError(returnTo, `${label} is invalid.`);
  }
  return undefined;
}

function readPositiveInteger(
  formData: FormData,
  key: string,
  returnTo: string,
  label: string
): number | undefined {
  const value = readString(formData, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
    redirectWithError(returnTo, `${label} must be a whole number from 1 to 3650.`);
  }
  return parsed;
}

function normalizeOwnerKey(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/\s+/gu, "_");
}

function safeReturnPath(path: string): string {
  return allowedReturnPaths.has(path) ? path : "/settings";
}

function redirectWithError(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message.slice(0, 180))}`);
}
