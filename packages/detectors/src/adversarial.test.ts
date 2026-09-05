import { describe, expect, it } from "vitest";
import type { ChangedFile, PullRequestInput } from "@agentforge/core";
import { extractVerifiedFacts } from "./index.js";

const basePr = (changedFiles: ChangedFile[]): PullRequestInput => ({
  repositoryFullName: "acme/app",
  pullRequestNumber: 7,
  title: "Adversarial detector input",
  authorLogin: "developer",
  baseBranch: "main",
  headBranch: "feature/input-boundaries",
  headSha: "head-7",
  changedFiles
});

describe("detectors adversarial boundaries", () => {
  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("falls back to bounded defaults for %s maxFiles", (_label, maxFiles) => {
    const files = Array.from({ length: 3 }, (_, index) => ({
      filename: `tests/file-${index}.test.ts`,
      status: "modified" as const,
      patch: "+test.skip('case', () => true);"
    }));

    const facts = extractVerifiedFacts(basePr(files), {}, { maxFiles });
    // The default cap is 1,000, so all three files remain visible. An invalid
    // negative/NaN limit must not accidentally slice away the input.
    expect(facts.filter((fact) => fact.type === "test_skipped")).toHaveLength(3);
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("falls back to a bounded patch limit for %s maxPatchBytes", (_label, maxPatchBytes) => {
    const file: ChangedFile = {
      filename: "tests/payment.test.ts",
      status: "modified",
      patch: "+test.skip('payment', () => true);"
    };

    expect(() => extractVerifiedFacts(basePr([file]), {}, { maxPatchBytes })).not.toThrow();
    expect(
      extractVerifiedFacts(basePr([file]), {}, { maxPatchBytes }).map((fact) => fact.type)
    ).toContain("test_skipped");
  });

  it("bounds patches by UTF-8 bytes, not UTF-16 code units", () => {
    const emojiPadding = "😀".repeat(10);
    const file: ChangedFile = {
      filename: "tests/payment.test.ts",
      status: "modified",
      patch: `${emojiPadding}+test.skip('payment', () => true);`
    };

    const facts = extractVerifiedFacts(basePr([file]), {}, { maxPatchBytes: 20 });
    expect(facts.some((fact) => fact.type === "detection_coverage_truncated")).toBe(true);
    // The skip call is outside the 20-byte UTF-8 window and must not be
    // observed just because each emoji occupies two JS code units.
    expect(facts.map((fact) => fact.type)).not.toContain("test_skipped");
  });

  it("still detects a credential after the bounded metadata excerpt", () => {
    const token = `ghp_${"1".repeat(36)}`;
    const file: ChangedFile = {
      filename: "src/generated.ts",
      status: "modified",
      patch: `+${"x".repeat(70_000)}\n+TOKEN=${token}`
    };

    const facts = extractVerifiedFacts(basePr([file]));
    const finding = facts.find((fact) => fact.type === "secret_like_value_detected");

    expect(finding).toMatchObject({
      severity: "critical",
      metadata: { secretRisk: "high", policyTreatment: "blocking" }
    });
    expect(JSON.stringify(finding)).not.toContain(token);
    expect(facts.some((fact) => fact.type === "detection_coverage_truncated")).toBe(true);
  });

  it("does not manufacture dependency facts from non-string package manifest values", () => {
    const file: ChangedFile = {
      filename: "package.json",
      status: "modified",
      previousContent: JSON.stringify({ dependencies: { stable: "1.0.0" } }),
      currentContent: JSON.stringify({
        dependencies: {
          stable: { malicious: "2.0.0" },
          broken: 42,
          valid: "2.0.0"
        }
      })
    };

    const facts = extractVerifiedFacts(basePr([file]));
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dependency_added",
          metadata: expect.objectContaining({ package: "valid", version: "2.0.0" })
        })
      ])
    );
    expect(facts.some((fact) => fact.metadata?.package === "broken")).toBe(false);
    expect(facts.some((fact) => fact.metadata?.package === "malicious")).toBe(false);
  });

  it("does not throw when package manifest content is a non-string runtime value", () => {
    const file = {
      filename: "package.json",
      status: "modified",
      previousContent: null,
      currentContent: { dependencies: { broken: "1.0.0" } }
    } as unknown as ChangedFile;

    expect(() => extractVerifiedFacts(basePr([file]))).not.toThrow();
    expect(extractVerifiedFacts(basePr([file]))).toEqual([]);
  });
});
