"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

export async function submitEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const recordId = readString(formData, "recordId");
  const evidenceId = readString(formData, "evidenceId");
  const kind = readString(formData, "kind");
  const content = readString(formData, "content");
  if (!recordId || !content || (!evidenceId && !kind)) {
    redirectWithError(returnTo, "evidence-submission-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/pull-requests/${encodeURIComponent(recordId)}/evidence`, {
      method: "POST",
      body: JSON.stringify({ evidenceId, kind, content })
    });
  } catch (error) {
    void error;
    redirectWithError(returnTo, "evidence-submission-failed");
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-submitted`);
}

export async function approveEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const evidenceId = readString(formData, "evidenceId");
  const recordId = readString(formData, "recordId");
  if (!evidenceId) {
    redirectWithError(returnTo, "evidence-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeURIComponent(evidenceId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId })
    });
  } catch (error) {
    void error;
    redirectWithError(returnTo, "evidence-approval-failed");
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-approved`);
}

export async function rejectEvidence(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const evidenceId = readString(formData, "evidenceId");
  const recordId = readString(formData, "recordId");
  const reason = readString(formData, "reason");
  if (!evidenceId || !reason) {
    redirectWithError(returnTo, "evidence-rejection-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeURIComponent(evidenceId)}/reject`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, reason })
    });
  } catch (error) {
    void error;
    redirectWithError(returnTo, "evidence-rejection-failed");
  }

  revalidateEvidencePaths(returnTo);
  redirect(`${returnTo}?updated=evidence-rejected`);
}

export async function approveReviewer(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const reviewerId = readString(formData, "reviewerId");
  const recordId = readString(formData, "recordId");
  if (!reviewerId) {
    redirectWithError(returnTo, "reviewer-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/reviewers/${encodeURIComponent(reviewerId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId })
    });
  } catch (error) {
    void error;
    redirectWithError(returnTo, "reviewer-approval-failed");
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
      "x-agentforge-authenticated-role": actor.role,
      "x-agentforge-authenticated-organization": actor.organizationId
    };
  }
  return {
    "x-agentforge-actor": actor.login,
    "x-agentforge-role": actor.role,
    "x-agentforge-organization": actor.organizationId
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
