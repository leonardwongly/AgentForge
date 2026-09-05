"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiActorHeaders } from "../settings/api-actor-headers";
import { resolveDashboardActor } from "../settings/actor";
import type { DashboardActorContext } from "../settings/actor-context";
import { readBoundedJson } from "../security/http";
import { encodeOpaqueSegment } from "../security/navigation";

type ExportFormat = "json" | "csv";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const exportFormats = new Set(["json", "csv"]);
const changedFileStatuses = new Set([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged"
]);
const MAX_CHANGED_FILES = 200;
const MAX_CHANGED_FILENAME_BYTES = 500;
const MAX_CHANGED_PATCH_BYTES = 200_000;
const MAX_CHANGED_INPUT_BYTES = 280_000;

export async function createRecordExport(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  const format = readExportFormat(formData, returnTo);
  let exportJob: { id: string; recordCount: number };

  try {
    const actor = await resolveDashboardActor();
    const payload = await requestJson<unknown>(actor, "/api/exports/change-control-records", {
      method: "POST",
      body: JSON.stringify({ format })
    });
    exportJob = readExportJob(payload);
  } catch (error) {
    void error;
    redirectWithError(returnTo, "record-export-failed");
  }

  revalidatePath("/records");
  redirect(
    `${returnTo}?updated=records-export&exportId=${encodeOpaqueSegment(
      exportJob.id
    )}&recordCount=${encodeURIComponent(String(exportJob.recordCount))}`
  );
}

export async function createCompliancePackageExport(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(readString(formData, "returnTo") ?? "/records");
  let exportJob: { id: string; recordCount: number };
  const maxRecords = readRequiredBoundedInteger(
    formData,
    "maxRecords",
    1,
    500,
    returnTo,
    "Record limit must be a whole number from 1 to 500.",
    250
  );
  const startDate = readDateTime(formData, "startDate", returnTo);
  const endDate = readDateTime(formData, "endDate", returnTo);
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
    redirectWithError(returnTo, "Start time must be before or equal to end time.");
  }
  const payload = {
    format: "json",
    repositoryId: readString(formData, "repositoryId"),
    policyPackId: readString(formData, "policyPackId"),
    policyVersion: readString(formData, "policyVersion"),
    startDate,
    endDate,
    maxRecords
  };

  try {
    const actor = await resolveDashboardActor();
    const responsePayload = await requestJson<unknown>(
      actor,
      "/api/exports/compliance-evidence-package",
      { method: "POST", body: JSON.stringify(payload) }
    );
    exportJob = readExportJob(responsePayload);
  } catch (error) {
    void error;
    redirectWithError(returnTo, "compliance-package-export-failed");
  }

  revalidatePath("/records");
  redirect(
    `${returnTo}?updated=compliance-package-export&exportId=${encodeOpaqueSegment(
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
  const pullRequestNumber = readRequiredBoundedInteger(
    formData,
    "pullRequestNumber",
    1,
    1_000_000,
    returnTo,
    "Enter a valid pull request number from 1 to 1000000."
  );
  const title = readString(formData, "title");
  const authorLogin = readString(formData, "authorLogin");
  const baseBranch = readString(formData, "baseBranch");
  const headBranch = readString(formData, "headBranch");
  const headSha = readString(formData, "headSha");
  const body = readString(formData, "body");
  const policyPackId = readString(formData, "policyPackId") ?? "fintech";
  const changedFiles = readChangedFiles(formData, returnTo);

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
    const pack = await requestJson<{ contentYaml?: unknown }>(
      actor,
      `/api/policy-packs/${encodeOpaqueSegment(policyPackId)}`,
      { method: "GET" }
    );
    if (typeof pack.contentYaml !== "string" || pack.contentYaml.trim().length === 0) {
      throw new Error("Selected policy pack does not include policy YAML.");
    }
    const payload = await requestJson<unknown>(actor, "/api/policies/preview", {
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
    });
    const record = readPersistedRecord(payload);
    await requestJson(
      actor,
      `/api/repositories/${encodeOpaqueSegment(record.repositoryId)}/policy`,
      { method: "PUT", body: JSON.stringify({ contentYaml: pack.contentYaml }) }
    );
    recordId = record.id;
  } catch (error) {
    void error;
    redirectWithError(returnTo, "Change Control Record could not be created.");
  }
  revalidatePath("/records");
  revalidatePath("/dashboard");
  redirect(`/records/${encodeOpaqueSegment(recordId)}?updated=standalone-record-created`);
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
    await requestJson(actor, `/api/pull-requests/${encodeOpaqueSegment(recordId)}/evidence`, {
      method: "POST",
      body: JSON.stringify({ evidenceId, kind, content, expectedRevision })
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
  const expectedRevision = readRevision(formData);
  if (!evidenceId || !recordId || expectedRevision === undefined) {
    redirectWithError(returnTo, "evidence-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeOpaqueSegment(evidenceId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision })
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
  const expectedRevision = readRevision(formData);
  if (!evidenceId || !recordId || expectedRevision === undefined || !reason) {
    redirectWithError(returnTo, "evidence-rejection-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/evidence/${encodeOpaqueSegment(evidenceId)}/reject`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision, reason })
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
  const expectedRevision = readRevision(formData);
  if (!reviewerId || !recordId || expectedRevision === undefined) {
    redirectWithError(returnTo, "reviewer-approval-required");
  }

  try {
    const actor = await resolveDashboardActor();
    await requestJson(actor, `/api/reviewers/${encodeOpaqueSegment(reviewerId)}/approve`, {
      method: "PATCH",
      body: JSON.stringify({ recordId, expectedRevision })
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
      ...apiActorHeaders(actor),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return await readBoundedJson<T>(response);
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await readBoundedJson<{ error?: string; message?: string }>(response, 64_000);
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

function readDateTime(formData: FormData, key: string, returnTo: string): string | undefined {
  const value = readString(formData, key);
  if (!value) {
    return undefined;
  }
  const normalized = value.length === 16 ? `${value}:00.000Z` : value;
  if (!Number.isFinite(Date.parse(normalized))) {
    redirectWithError(returnTo, "Export dates must be valid UTC date-times.");
  }
  return new Date(normalized).toISOString();
}

function readRequiredBoundedInteger(
  formData: FormData,
  key: string,
  min: number,
  max: number,
  returnTo: string,
  message: string,
  fallback: number | undefined = undefined
): number {
  const value = readString(formData, key);
  if (!value || !/^\d+$/u.test(value)) {
    if (!value && fallback !== undefined) {
      return fallback;
    }
    redirectWithError(returnTo, message);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    redirectWithError(returnTo, message);
  }
  return parsed;
}

function readExportJob(value: unknown): { id: string; recordCount: number } {
  if (!value || typeof value !== "object") {
    throw new Error("Export API returned an invalid job.");
  }
  const job = value as { id?: unknown; recordCount?: unknown };
  if (
    typeof job.id !== "string" ||
    job.id.trim().length === 0 ||
    job.id.length > 200 ||
    !Number.isSafeInteger(job.recordCount) ||
    (job.recordCount as number) < 0 ||
    (job.recordCount as number) > 1_000
  ) {
    throw new Error("Export API returned an invalid job.");
  }
  return { id: job.id, recordCount: job.recordCount as number };
}

function readPersistedRecord(value: unknown): { id: string; repositoryId: string } {
  if (!value || typeof value !== "object") {
    throw new Error("Preview API returned an invalid record.");
  }
  const record = (value as { record?: unknown }).record;
  if (!record || typeof record !== "object") {
    throw new Error("Preview API returned an invalid record.");
  }
  const candidate = record as { id?: unknown; repositoryId?: unknown };
  if (
    typeof candidate.id !== "string" ||
    candidate.id.trim().length === 0 ||
    candidate.id.length > 200 ||
    typeof candidate.repositoryId !== "string" ||
    candidate.repositoryId.trim().length === 0 ||
    candidate.repositoryId.length > 200
  ) {
    throw new Error("Preview API returned an invalid record.");
  }
  return { id: candidate.id, repositoryId: candidate.repositoryId };
}

function readExportFormat(formData: FormData, returnTo: string): ExportFormat {
  const format = readString(formData, "format") ?? "json";
  if (!exportFormats.has(format)) {
    redirectWithError(returnTo, "Export format is invalid.");
  }
  return format as ExportFormat;
}

function readChangedFiles(
  formData: FormData,
  returnTo: string
): Array<{ filename: string; status: string; patch?: string }> {
  const files: Array<{ filename: string; status: string; patch?: string }> = [];
  let totalBytes = 0;
  for (let index = 0; index <= MAX_CHANGED_FILES; index += 1) {
    const filenameKey = `filename_${index}`;
    const filenameValues = formData.getAll(filenameKey);
    if (index === MAX_CHANGED_FILES && filenameValues.length > 0) {
      redirectWithError(returnTo, "A maximum of 200 changed files may be submitted.");
    }
    if (filenameValues.length === 0) {
      const hasLaterFilename = Array.from({ length: MAX_CHANGED_FILES - index }, (_, offset) =>
        formData.has(`filename_${index + offset + 1}`)
      ).some(Boolean);
      if (hasLaterFilename || formData.has(`status_${index}`) || formData.has(`patch_${index}`)) {
        redirectWithError(returnTo, "Changed file rows must be contiguous.");
      }
      break;
    }
    if (filenameValues.length !== 1 || typeof filenameValues[0] !== "string") {
      redirectWithError(returnTo, "Changed file rows are invalid.");
    }
    const filename = (filenameValues[0] as string).trim();
    if (filename.length === 0 || Buffer.byteLength(filename, "utf8") > MAX_CHANGED_FILENAME_BYTES) {
      redirectWithError(returnTo, "Changed file names must be 500 bytes or smaller.");
    }

    const statusValues = formData.getAll(`status_${index}`);
    if (
      statusValues.length > 1 ||
      (statusValues.length === 1 && typeof statusValues[0] !== "string")
    ) {
      redirectWithError(returnTo, "Changed file rows are invalid.");
    }
    const status = statusValues.length === 0 ? "modified" : String(statusValues[0]).trim();
    if (!changedFileStatuses.has(status)) {
      redirectWithError(returnTo, "Changed file status is invalid.");
    }

    const patchValues = formData.getAll(`patch_${index}`);
    if (
      patchValues.length > 1 ||
      (patchValues.length === 1 && typeof patchValues[0] !== "string")
    ) {
      redirectWithError(returnTo, "Changed file rows are invalid.");
    }
    const patch = patchValues.length === 0 ? undefined : (patchValues[0] as string);
    if (patch !== undefined && Buffer.byteLength(patch, "utf8") > MAX_CHANGED_PATCH_BYTES) {
      redirectWithError(returnTo, "Each changed file patch must be 200 KB or smaller.");
    }
    totalBytes += Buffer.byteLength(filename, "utf8") + Buffer.byteLength(status, "utf8");
    if (patch) {
      totalBytes += Buffer.byteLength(patch, "utf8");
    }
    if (totalBytes > MAX_CHANGED_INPUT_BYTES) {
      redirectWithError(returnTo, "Changed file details exceed the request size limit.");
    }
    files.push({ filename, status, ...(patch ? { patch } : {}) });
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
  // Accept one encoded path segment for opaque record IDs (including IDs that
  // contain a slash), while rejecting query/hash/open-redirect components.
  const match = /^\/records\/([^/?#]+)$/u.exec(path);
  if (match) {
    try {
      const encodedSegment = match[1];
      if (!encodedSegment) {
        return "/records";
      }
      const decoded = decodeURIComponent(encodedSegment);
      if (
        !/[\u0000-\u001f\u007f]/u.test(decoded) &&
        encodeOpaqueSegment(decoded) === encodedSegment
      ) {
        return path;
      }
    } catch {
      // Fall through to the safe list default.
    }
  }
  return "/records";
}
