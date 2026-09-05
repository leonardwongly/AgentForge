import type { GitReader } from "@agentforge/loom-git-bridge";
import { generateKeyPair } from "@agentforge/loom-provenance";
import { describe, expect, it } from "vitest";
import { ratify, verifyAttestation } from "./engine.js";

const sensitiveTree = {
  "README.md": "# Demo\n",
  "src/app.ts": "export const x = 1;\n",
  "src/billing/charge.ts": "export const charge = (): number => 1;\n"
};

const trees: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  base: { "README.md": "# Demo\n", "src/app.ts": "export const x = 1;\n" },
  base_with_sensitive: sensitiveTree,
  head_clean: { "README.md": "# Demo v2\n", "src/app.ts": "export const x = 1;\n" },
  head_sensitive: sensitiveTree
};

function fakeReader(): GitReader {
  return {
    lsTree: (ref) =>
      Promise.resolve(
        Object.keys(trees[ref] ?? {}).map((path) => ({
          path,
          mode: "100644",
          type: "blob" as const
        }))
      ),
    readFile: (ref, path) => Promise.resolve((trees[ref] ?? {})[path] ?? "")
  };
}

const warnPolicy = `version: 1
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
`;

const enforceBillingPolicy = `version: 1
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "alice"
`;

const approval = {
  reviewer: "alice",
  reviewerType: "user" as const,
  state: "APPROVED" as const,
  submittedAt: "2026-07-06T00:00:00.000Z"
};

function baseReq() {
  return {
    reader: fakeReader(),
    baseRef: "base",
    space: "demo/repo",
    lineRef: "main",
    proposalId: "p1",
    title: "demo change",
    author: "dev"
  };
}

describe("loom CLI engine — git refs -> decision -> provenance", () => {
  it("passes a non-sensitive change under warn mode without an attestation", async () => {
    const res = await ratify({ ...baseReq(), headRef: "head_clean", policyYaml: warnPolicy });
    expect(res.evaluation.result.status).toBe("pass");
    expect(res.evaluation.diff.length).toBeGreaterThanOrEqual(1);
    expect(res.envelope).toBeUndefined();
    expect(res.resultAddress.startsWith("loom:sha256:")).toBe(true);
  });

  it("blocks a sensitive-path change with no required reviewer", async () => {
    const res = await ratify({
      ...baseReq(),
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy
    });
    expect(res.evaluation.result.status).toBe("block");
  });

  it("passes the sensitive-path change once the required reviewer approves", async () => {
    const res = await ratify({
      ...baseReq(),
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy,
      reviews: [approval]
    });
    expect(res.evaluation.result.status).toBe("pass");
  });

  it("signs an attestation that independently verifies against the same transition", async () => {
    const key = generateKeyPair();
    const res = await ratify({
      ...baseReq(),
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy,
      reviews: [approval],
      sign: { key, checkerDid: "did:loom:test", detectorSuiteVersion: "test@1", policyVersion: "1" }
    });
    const envelope = res.envelope;
    expect(envelope).toBeDefined();
    if (!envelope) {
      throw new Error("envelope missing");
    }
    const verified = await verifyAttestation({
      reader: fakeReader(),
      baseRef: "base",
      headRef: "head_sensitive",
      envelope,
      publicKeyPem: key.publicKeyPem,
      policyVersion: "1"
    });
    expect(verified.verdict.ok).toBe(true);
    expect(verified.baseAddress).toBe(res.baseAddress);
    expect(verified.resultAddress).toBe(res.resultAddress);
    expect(verified.subjectAddress).toBe(res.subjectAddress);
  });

  it("rejects the attestation when verified against a different head", async () => {
    const key = generateKeyPair();
    const res = await ratify({
      ...baseReq(),
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy,
      reviews: [approval],
      sign: { key, checkerDid: "did:loom:test", detectorSuiteVersion: "test@1", policyVersion: "1" }
    });
    const envelope = res.envelope;
    if (!envelope) {
      throw new Error("envelope missing");
    }
    const verified = await verifyAttestation({
      reader: fakeReader(),
      baseRef: "base",
      headRef: "head_clean",
      envelope,
      publicKeyPem: key.publicKeyPem,
      policyVersion: "1"
    });
    expect(verified.verdict.ok).toBe(false);
  });

  it("rejects replay across bases when identical heads produce different policy outcomes", async () => {
    const key = generateKeyPair();
    const signed = await ratify({
      ...baseReq(),
      baseRef: "base",
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy,
      sign: { key, checkerDid: "did:loom:test", detectorSuiteVersion: "test@1", policyVersion: "1" }
    });
    const otherBase = await ratify({
      ...baseReq(),
      baseRef: "base_with_sensitive",
      headRef: "head_sensitive",
      policyYaml: enforceBillingPolicy
    });

    expect(signed.evaluation.result.status).toBe("block");
    expect(otherBase.evaluation.result.status).toBe("pass");
    expect(otherBase.resultAddress).toBe(signed.resultAddress);
    expect(otherBase.baseAddress).not.toBe(signed.baseAddress);

    const envelope = signed.envelope;
    if (!envelope) {
      throw new Error("envelope missing");
    }
    const original = await verifyAttestation({
      reader: fakeReader(),
      baseRef: "base",
      headRef: "head_sensitive",
      envelope,
      publicKeyPem: key.publicKeyPem,
      policyVersion: "1"
    });
    const replayed = await verifyAttestation({
      reader: fakeReader(),
      baseRef: "base_with_sensitive",
      headRef: "head_sensitive",
      envelope,
      publicKeyPem: key.publicKeyPem,
      policyVersion: "1"
    });

    expect(original.verdict).toEqual({ ok: true });
    expect(replayed.verdict).toEqual({
      ok: false,
      reason: "subject does not match expected transition"
    });
  });

  it("throws on invalid policy YAML", async () => {
    await expect(
      ratify({
        ...baseReq(),
        headRef: "head_clean",
        policyYaml:
          "version: 1\nagentforge:\n  mode: nonsense\n  apply_to:\n    - all_pull_requests\n"
      })
    ).rejects.toThrow(/policy invalid/u);
  });
});
