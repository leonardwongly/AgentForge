import { describe, expect, it } from "vitest";
import {
  buildLlmAdvisoryPrompt,
  detectSecrets,
  redactObject,
  redactSecrets,
  sanitizeForMetadataStorage
} from "./index.js";

describe("redaction", () => {
  it("redacts common credentials without removing surrounding context", () => {
    const input = "token=ghp_123456789012345678901234567890123456 aws=AKIA1234567890ABCDEF";

    const redacted = redactSecrets(input);

    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).not.toContain("ghp_123456");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
  });

  it("redacts nested object strings", () => {
    const value = redactObject({
      url: "postgres://user:pass@example.com/db",
      nested: { header: "Bearer abcdefghijklmnopqrstuvwxyz123456" }
    });

    expect(value.url).toBe("postgres://[REDACTED]@example.com/db");
    expect(value.nested.header).toBe("Bearer [REDACTED]");
  });

  it("detects secret-like values", () => {
    const matches = detectSecrets("client_secret: abcdefghijklmnopqrstuvwxyz1234567890");
    expect(matches.map((match) => match.kind)).toContain("api_key_assignment");
    expect(matches.find((match) => match.kind === "api_key_assignment")).toMatchObject({
      category: "credential_like",
      risk: "high"
    });
  });

  it("classifies local placeholders separately while still redacting them", () => {
    const input =
      "DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge\nAPI_KEY=placeholder-local-only-token";
    const matches = detectSecrets(input);

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "database_url",
          category: "local_placeholder",
          risk: "low"
        }),
        expect.objectContaining({
          kind: "api_key_assignment",
          category: "local_placeholder",
          risk: "low"
        })
      ])
    );
    expect(redactSecrets(input)).not.toContain("agentforge:agentforge");
    expect(redactSecrets(input)).not.toContain("placeholder-local-only-token");
  });

  it("removes source blobs and full diffs by default while preserving metadata", () => {
    const value = sanitizeForMetadataStorage({
      filename: "src/billing/checkout.ts",
      patch: "+ const token = 'ghp_123456789012345678901234567890123456'",
      previousContent: "export const before = true;",
      currentContent: "export const after = true;",
      evidence: "Changed path matched billing policy"
    });

    expect(value).toEqual({
      filename: "src/billing/checkout.ts",
      evidence: "Changed path matched billing policy"
    });
    expect(JSON.stringify(value)).not.toContain("ghp_123456");
    expect(JSON.stringify(value)).not.toContain("export const");
  });

  it("retains redacted diffs only when diff retention is enabled", () => {
    const value = sanitizeForMetadataStorage(
      {
        patch: "+ token=ghp_123456789012345678901234567890123456",
        currentContent: "const source = true;"
      },
      { fullDiffRetention: "7d", sourceCodeStorage: false, redactSecrets: true }
    );

    expect(value).toEqual({ patch: "+ token=[REDACTED]" });
  });

  it("does not generate advisory prompts when LLM features are disabled", () => {
    const prompt = buildLlmAdvisoryPrompt({
      llmFeatures: false,
      findings: [
        {
          id: "fact_1",
          type: "secret_like_value_detected",
          evidence: "token=ghp_123456789012345678901234567890123456",
          confidence: "observed"
        }
      ],
      requiredEvidence: [{ kind: "security_note", status: "missing" }],
      requiredReviewers: [{ reviewer: "security-team", tier: "required", approved: false }]
    });

    expect(prompt).toEqual({
      enabled: false,
      advisoryOnly: true,
      promptGenerated: false,
      deterministicFindingIds: ["fact_1"]
    });
    expect("prompt" in prompt).toBe(false);
  });

  it("separates enabled advisory prompts from deterministic blocking findings", () => {
    const prompt = buildLlmAdvisoryPrompt({
      llmFeatures: true,
      findings: [
        {
          id: "fact_1",
          type: "secret_like_value_detected",
          evidence: "token=ghp_123456789012345678901234567890123456",
          confidence: "observed"
        }
      ],
      requiredEvidence: [{ kind: "security_note", status: "missing" }],
      requiredReviewers: [{ reviewer: "security-team", tier: "required", approved: false }]
    });

    expect(prompt.enabled).toBe(true);
    expect(prompt.advisoryOnly).toBe(true);
    expect(prompt.promptGenerated).toBe(true);
    if (prompt.promptGenerated) {
      expect(prompt.prompt).toContain("advisory only");
      expect(prompt.prompt).not.toContain("ghp_123456");
    }
  });
});
