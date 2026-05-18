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
    redirect(
      `${returnTo}?error=${encodeURIComponent(
        error instanceof Error ? error.message.slice(0, 180) : "Record export could not be created."
      )}`
    );
  }

  revalidatePath("/records");
  redirect(
    `${returnTo}?updated=records-export&exportId=${encodeURIComponent(
      exportJob.id
    )}&recordCount=${encodeURIComponent(String(exportJob.recordCount))}`
  );
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

function readString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readExportFormat(formData: FormData): ExportFormat {
  const format = readString(formData, "format") ?? "json";
  return exportFormats.has(format) ? (format as ExportFormat) : "json";
}

function safeReturnPath(path: string): string {
  if (path === "/dashboard" || path === "/records" || path === "/settings") {
    return path;
  }
  if (/^\/records\/[A-Za-z0-9_-]+$/u.test(path)) {
    return path;
  }
  return "/records";
}
