import { describe, expect, it } from "vitest";
import type { AuditEventRecord } from "@agentforge/core";

import {
  AUDIT_CHAIN_GENESIS,
  auditChainDigest,
  chainAuditEvents,
  verifyAuditChain
} from "./index.js";

function event(id: string, actor: string, action: AuditEventRecord["action"]): AuditEventRecord {
  return {
    id,
    schemaVersion: 1,
    organizationId: "org",
    actor,
    actorRole: "platform_admin",
    action,
    targetType: "change_control_record",
    targetId: "record-1",
    source: "api",
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`
  };
}

const events: AuditEventRecord[] = [
  event("e1", "admin", "override_created"),
  event("e2", "system", "check_published"),
  event("e3", "auditor", "record_exported")
];

describe("tamper-evident audit chain", () => {
  it("produces a deterministic, verifiable chain", () => {
    const chained = chainAuditEvents(events);
    expect(chained).toHaveLength(3);
    expect(verifyAuditChain(chained).valid).toBe(true);
    // Determinism: identical input yields identical hashes.
    const again = chainAuditEvents(events);
    expect(auditChainDigest(chained)).toBe(auditChainDigest(again));
  });

  it("links each event to the previous hash", () => {
    const chained = chainAuditEvents(events);
    const [first, second] = chained as [AuditEventRecord, AuditEventRecord];
    const firstChain = first.metadataJson?.auditChain as {
      index: number;
      prevHash: string;
      hash: string;
    };
    const secondChain = second.metadataJson?.auditChain as {
      index: number;
      prevHash: string;
      hash: string;
    };
    expect(firstChain.index).toBe(0);
    expect(firstChain.prevHash).toBe(AUDIT_CHAIN_GENESIS);
    expect(secondChain.prevHash).toBe(firstChain.hash);
  });

  it("detects tampering of an event payload", () => {
    const chained = chainAuditEvents(events);
    const tampered = chained.map((e) => (e.id === "e2" ? { ...e, actor: "attacker" } : e));
    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("tampered");
  });

  it("detects reordering", () => {
    const chained = chainAuditEvents(events);
    const reordered = [chained[2]!, chained[0]!, chained[1]!];
    expect(verifyAuditChain(reordered).valid).toBe(false);
  });

  it("detects a removed event against the expected digest", () => {
    const chained = chainAuditEvents(events);
    const digest = auditChainDigest(chained);
    expect(verifyAuditChain(chained.slice(0, 2), { expectedDigest: digest }).valid).toBe(false);
  });

  it("returns the genesis digest for an empty chain", () => {
    expect(auditChainDigest([])).toBe(AUDIT_CHAIN_GENESIS);
  });
});
