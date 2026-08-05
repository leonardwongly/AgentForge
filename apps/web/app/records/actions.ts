"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiActorHeaders } from "../settings/api-actor-headers";
import { resolveDashboardActor } from "../settings/actor";
import type { DashboardActorContext } from "../settings/actor-context";

type ExportFormat = "json" | "csv";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const exportFormats = new Set(["json", "csv"]);

export async function createRecordExport(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const format = readExportFormat(formData);
  let exportJob: { id: string; recordCount: number };

  try {
    const actor = await resolveDashboardActor();
    exportJob = await requestJson<{ id: string; recordCount: number }>(
      actor,
      "/api/exports/change-control-records",
      { method: "POST", body: JSON.stringify({ format }) }
    );
  } catch (error) {
    void error;
    redirectWithError(returnTo, "record-export-failed");
  }

  revalidatePath("/records");
  redirect(
    `${returnTo}?updated=records-export&exportId=${encodeURIComponent(
      exportJob.id
    )}&recordCount=${encodeURIComponent(String(exportJob.recordCount))}`
  );
}

export async function createCompliancePackageExport(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  let exportJob: { id: string; recordCount: number };
  const payload = {
    format: "json",
    repositoryId: readString(formData, "repositoryId"),
    policyPackId: readString(formData, "policyPackId"),
    policyVersion: readString(formData, "policyVersion"),
    startDate: readDateTime(formData, "startDate"),
    endDate: readDateTime(formData, "endDate"),
    maxRecords: readBoundedInteger(formData, "maxRecords", 250, 1, 500)
  };

  try {
    const actor = await resolveDashboardActor();
    exportJob = await requestJson<{ id: string; recordCount: number }>(
      actor,
      "/api/exports/compliance-evidence-package",
      { method: "POST", body: JSON.stringify(payload) }
    );
  } catch (error) {
    void error;
    redirectWithError(returnTo, "compliance-package-export-failed");
  }

  revalidatePath("/records");
  redirect(
    `${returnTo}?updated=compliance-package-export&exportId=${encodeURIComponent(
      exportJob.id
    )}&recordCount=${encodeURIComponent(String(exportJob.recordCount))}`
  );
}

// Standalone ingestion: create a Change Control Record directly from PR
// details without requiring a GitHub webhook. The record is persisted through
// the policy-preview API and evaluated against the selected policy pack.
export async function createStandaloneRecord(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const repositoryFullName = readString(formData, "repositoryFullName");
  const pullRequestNumber = readBoundedInteger(formData, "pullRequestNumber", 0, 1, 1_000_000);
  const title = readString(formData, "title");
  const authorLogin = readString(formData, "authorLogin");
  const baseBranch = readString(formData, "baseBranch");
  const headBranch = readString(formData, "headBranch");
  const headSha = readString(formData, "headSha");
  const body = readString(formData, "body");
  const policyPackId = readString(formData, "policyPackId") ?? "fintech";
  const changedFiles = readChangedFiles(formData);

  if (
    !repositoryFullName ||
    !title ||
    !authorLogin ||
    !baseBranch ||
    !headBranch ||
    !headSha ||
    changedFiles.length === 0
  ) {
    redirectWithError(returnTo, "Provide repository, PR details, and at least one changed file.");
  }

  let recordId: string;
  try {
    const actor = await resolveDashboardActor();
    const pack = await requestJson<{ contentYaml?: string }>(
      actor,
      `/api/policy-packs/${encodeURIComponent(policyPackId)}`,
      { method: "GET" }
    );
    if (!pack.contentYaml) {
      throw new Error("Selected policy pack does not include policy YAML.");
    }
    const payload = await requestJson<{ record: { id: string; repositoryId: string } }>(
      actor,
      "/api/policies/preview",
      {
        method: "POST",
        body: JSON.stringify({
          contentYaml: pack.contentYaml,
          persist: true,
          pr: {
            repositoryFullName,
            pullRequestNumber,
            title,
            authorLogin,
            baseBranch,
            headBranch,
            headSha,
            ...(body ? { body } : {}),
            changedFiles
          }
        })
      }
    );
    await requestJson(
      actor,
      `/api/repositories/${encodeURIComponent(payload.record.repositoryId)}/policy`,
      { method: "PUT", body: JSON.stringify({ contentYaml: pack.contentYaml }) }
    );
    recordId = payload.record.id;
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "Change Control Record could not be created."
    );
  }
  revalidatePath("/records");
  revalidatePath("/dashboard");
  redirect(`/records/${encodeURIComponent(recordId)}?updated=standalone-record-created`);
}

export async function submitEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const recordId = readString(formData, "recordId");
  const evidenceId = readString(formData, "evidenceId");
  const kind = readString(formData, "kind");
  const content = readString(formData, "content");
  const expectedRevision = readRevision(formData);
  if (!recordId || expectedRevision === undefined || !content || (!evidenceId && !kind)) {
    redirectWithError(returnTo, "evidence-submission-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/pull-requests/${encodeURIComponent(recordId)}/evidence`, {
      method: "POST",
      body: JSON.stringify({ evidenceId, kind, content, expectedRevision })
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "evidence-submission-failed"
    );
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-submitted`);
}

export async function approveEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const evidenceId = readString(formData, "evidenceId");
  const recordId = readString(formData, "recordId");
  const expectedRevision = readRevision(formData);
  if (!evidenceId || !recordId || expectedRevision === undefined) {
    redirectWithError(returnTo, "evidence-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeURIComponent(evidenceId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision })
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "evidence-approval-failed"
    );
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-approved`);
}

export async function rejectEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const evidenceId = readString(formData, "evidenceId");
  const recordId = readString(formData, "recordId");
  const reason = readString(formData, "reason");
  const expectedRevision = readRevision(formData);
  if (!evidenceId || !recordId || expectedRevision === undefined || !reason) {
    redirectWithError(returnTo, "evidence-rejection-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeURIComponent(evidenceId)}/reject`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision, reason })
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "evidence-rejection-failed"
    );
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-rejected`);
}

export async function approveReviewer(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const reviewerId = readString(formData, "reviewerId");
  const recordId = readString(formData, "recordId");
  const expectedRevision = readRevision(formData);
  if (!reviewerId || !recordId || expectedRevision === undefined) {
    redirectWithError(returnTo, "reviewer-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/reviewers/${encodeURIComponent(reviewerId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision })
    });
  } catch (error) {
    redirectWithError(
      returnTo,
      error instanceof Error ? error.message : "reviewer-approval-failed"
    );
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=reviewer-approved`);
}

async function requestJson<T>(
  actor: DashboardActorContext,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
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

function readRevision(formData: FormData): number | undefined {
  const value = Number(readString(formData, "expectedRevision"));
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readDateTime(formData: FormData, key: string): string | undefined {
  const value = readString(formData, key);
  if (!value) {
    return undefined;
  }
  const normalized = value.length === 16 ? `${value}:00.000Z` : value;
  return Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : undefined;
}

function readBoundedInteger(
  formData: FormData,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(readString(formData, key));
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function readExportFormat(formData: FormData): ExportFormat {
  const format = readString(formData, "format") ?? "json";
  return exportFormats.has(format) ? (format as ExportFormat) : "json";
}

function readChangedFiles(
  formData: FormData
): Array<{ filename: string; status: string; patch?: string }> {
  const files: Array<{ filename: string; status: string; patch?: string }> = [];
  let index = 0;
  while (true) {
    const filename = readString(formData, `filename_${index}`);
    if (!filename) {
      break;
    }
    const status = readString(formData, `status_${index}`) ?? "modified";
    const patch = readString(formData, `patch_${index}`);
    files.push({ filename, status, ...(patch ? { patch } : {}) });
    index += 1;
  }
  return files;
}

function revalidateEvidencePaths(returnTo: string): void {
  revalidatePath(returnTo);
  revalidatePath("/records");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/evidence-completion");
  revalidatePath("/dashboard/blocked-prs");
}

function redirectWithError(returnTo: string, code: string): never {
  redirect(`${returnTo}?error=${encodeURIComponent(code)}`);
}

function safeReturnPath(path: string): string {
  if (
    path === "/dashboard" ||
    path === "/dashboard/evidence-completion" ||
    path === "/records" ||
    path === "/settings"
  ) {
    return path;
  }
  if (/^\/records\/[A-Za-z0-9_-]+$/u.test(path)) {
    return path;
  }
  return "/records";
}
