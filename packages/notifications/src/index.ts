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
import { isIP } from "node:net";

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

const MAX_WEBHOOK_RETRIES = 8;
const MAX_WEBHOOK_TIMEOUT_MS = 60_000;
const MAX_WEBHOOK_PAYLOAD_BYTES = 1_048_576;

// Best-effort, non-blocking webhook delivery with a timeout and a small retry.
// Any failure is reported but never thrown, so callers cannot be taken down by
// an unreachable notification endpoint.
export async function deliverWebhook(
  url: string,
  payload: unknown,
  options: DeliveryOptions = {}
): Promise<DeliveryResult> {
  if (!isSafeWebhookDestination(url)) {
    return { ok: false, error: "invalid webhook destination" };
  }
  let body: string;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") {
      return { ok: false, error: "invalid webhook payload" };
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_WEBHOOK_PAYLOAD_BYTES) {
      return { ok: false, error: "webhook payload too large" };
    }
    body = serialized;
  } catch {
    // Circular or otherwise non-serializable payloads should be reported to
    // the caller, not retried repeatedly while holding request resources.
    return { ok: false, error: "invalid webhook payload" };
  }
  // Keep untrusted configuration from turning delivery into an unbounded
  // resource consumer. Negative/NaN values are normalized to safe defaults;
  // retries are capped while preserving the documented small retry behavior.
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const retries = normalizeRetries(options.retries);
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
          body,
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

function isSafeWebhookDestination(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const ipLiteral = hostname.replace(/^\[|\]$/gu, "");
    if (parsed.protocol !== "https:" || !hostname || parsed.username || parsed.password) {
      return false;
    }
    return !(
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname === "metadata.google.internal" ||
      isPrivateIpLiteral(ipLiteral) ||
      hostname === "169.254.169.254" ||
      /^127\./u.test(hostname) ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(hostname)
    );
  } catch {
    return false;
  }
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_WEBHOOK_TIMEOUT_MS)
    : 5_000;
}

function normalizeRetries(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), MAX_WEBHOOK_RETRIES)
    : 2;
}

function isPrivateIpLiteral(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  if (version !== 6) {
    return false;
  }
  const normalized = hostname.toLowerCase();
  if (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  // Node normalizes IPv4-mapped literals to hex (e.g. ::ffff:7f00:1).
  const mapped = normalized.match(/^::ffff:([0-9a-f]{4}):([0-9a-f]{1,4})$/u);
  if (!mapped) {
    return false;
  }
  const first = Number.parseInt(mapped[1]!, 16);
  const second = Number.parseInt(mapped[2]!.padStart(4, "0"), 16);
  const a = first >> 8;
  const b = first & 0xff;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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
