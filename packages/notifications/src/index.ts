/**
 * AgentForge notifications.
 *
 * Outbound, best-effort webhook notifications for governance events (G6) and
 * SIEM-style streaming of tamper-evident audit events (G7). Delivery is
 * non-blocking and gated by configuration: nothing is sent unless a webhook URL
 * is configured, so these functions are safe no-ops in tests and default
 * installs.
 */
import type { AuditEventRecord, ChangeControlRecord } from "@agentforge/core";

import { auditChainDigest, chainAuditEvents } from "@agentforge/records";

export type NotificationEventType =
  | "pr_blocked"
  | "evidence_required"
  | "override_requested"
  | "override_approved"
  | "check_published";

export type NotificationFinding = {
  type: string;
  severity?: string | undefined;
  path?: string | undefined;
};

export type NotificationPayload = {
  schemaVersion: 1;
  event: NotificationEventType;
  generatedAt: string;
  organizationId?: string | undefined;
  repositoryFullName?: string | undefined;
  pullRequestNumber?: number | undefined;
  headSha?: string | undefined;
  policyVersion?: string | undefined;
  mode?: string | undefined;
  checkStatus?: string | undefined;
  lifecycle?: string | undefined;
  summary: string;
  detailsUrl?: string | undefined;
  findings: NotificationFinding[];
};

export type NotificationInput = {
  event: NotificationEventType;
  record: ChangeControlRecord;
  generatedAt?: string | undefined;
  detailsUrl?: string | undefined;
};

export function buildNotificationPayload(input: NotificationInput): NotificationPayload {
  const { record, event } = input;
  return {
    schemaVersion: 1,
    event,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    organizationId: record.organizationId,
    repositoryFullName: record.repositoryFullName,
    pullRequestNumber: record.pullRequestNumber,
    headSha: record.headSha,
    policyVersion: record.policyVersion,
    mode: record.mode,
    checkStatus: record.checkStatus,
    lifecycle: record.lifecycle,
    summary: summarize(event, record),
    detailsUrl: input.detailsUrl,
    findings: record.verifiedFindings.map((finding) => ({
      type: finding.type,
      severity: finding.severity,
      path: finding.path
    }))
  };
}

function summarize(event: NotificationEventType, record: ChangeControlRecord): string {
  const repo = `${record.repositoryFullName}#${record.pullRequestNumber}`;
  switch (event) {
    case "pr_blocked":
      return `Merge Guard blocked ${repo}: ${record.verifiedFindings.length} finding(s) unresolved.`;
    case "evidence_required":
      return `Evidence required for ${repo}: ${record.requiredEvidence.length} requirement(s) open.`;
    case "override_requested":
      return `Override requested for ${repo}.`;
    case "override_approved":
      return `Override approved for ${repo}.`;
    case "check_published":
      return `Merge Guard check published for ${repo} (${record.checkStatus}).`;
  }
}

export type DeliveryResult = {
  ok: boolean;
  status?: number | undefined;
  error?: string | undefined;
};

export type DeliveryOptions = {
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  fetchImpl?: typeof fetch;
};

// Best-effort, non-blocking webhook delivery with a timeout and a small retry.
// Any failure is reported but never thrown, so callers cannot be taken down by
// an unreachable notification endpoint.
export async function deliverWebhook(
  url: string,
  payload: unknown,
  options: DeliveryOptions = {}
): Promise<DeliveryResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retries = options.retries ?? 2;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (response.ok) {
          return { ok: true, status: response.status };
        }
        lastError = `HTTP ${response.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) {
      await sleep(200 * 2 ** attempt);
    }
  }
  return { ok: false, error: lastError };
}

export type AuditStreamPayload = {
  schemaVersion: 1;
  generatedAt: string;
  digest: string;
  eventCount: number;
  events: AuditEventRecord[];
};

// Serialize a tamper-evident chain of audit events for SIEM-style streaming.
// The digest lets a downstream SIEM verify the chain's integrity.
export function buildAuditStreamPayload(
  events: AuditEventRecord[],
  generatedAt = new Date().toISOString()
): AuditStreamPayload {
  const chained = chainAuditEvents(events);
  return {
    schemaVersion: 1,
    generatedAt,
    digest: auditChainDigest(chained),
    eventCount: chained.length,
    events: chained
  };
}

export async function streamAuditEvents(
  url: string,
  events: AuditEventRecord[],
  options: DeliveryOptions = {}
): Promise<DeliveryResult> {
  return deliverWebhook(url, buildAuditStreamPayload(events), options);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
