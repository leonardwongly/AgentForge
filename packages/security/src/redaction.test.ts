import { describe, expect, it } from "vitest";
import {
  buildLlmAdvisoryPrompt,
  detectSecrets,
  redactObject,
  redactSecrets,
  sanitizeForMetadataStorage
} from "./index.js";

describe("redaction", () => {
  const rawGithubToken = `ghp_${"1".repeat(36)}`;
  const rawAwsKey = `AKIA${"1234567890ABCDEF"}`;

  it("redacts common credentials without removing surrounding context", () => {
    const input = `token=${rawGithubToken} aws=${rawAwsKey}`;

    const redacted = redactSecrets(input);

    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).not.toContain("ghp_123456");
    expect(redacted).not.toContain(rawAwsKey);
  });

  describe("expanded credential patterns", () => {
    // Exactly 86 base64 chars + "==" padding = 88 chars total, matching the
    // real Azure Storage AccountKey shape.
    const fakeAzureAccountKey = `${"a1B2".repeat(21)}Q9==`;
    const fakeAzureConnectionString = `DefaultEndpointsProtocol=https;AccountName=agentforgestorage;AccountKey=${fakeAzureAccountKey};EndpointSuffix=core.windows.net`;
    const fakeCloudflareToken = `cfat_${"A9bK".repeat(10)}chk1`;
    const fakeTwilioAccountSid = `AC${"a1b2c3d4".repeat(4)}`;
    const fakeTwilioApiKeySid = `SK${"9f8e7d6c".repeat(4)}`;
    const fakeTwilioAuthToken = "3f9a2b7c1e6d4f8a0c5b9e2d7f1a4c6b";
    const fakeAwsSecretKey = "qT7mLp2Ns9VbXcZk4RaWy8FdGh3Jq6Ut1BvNw5Cx";

    it("has a well-formed 88-char Azure account key fixture", () => {
      expect(fakeAzureAccountKey).toHaveLength(88);
      expect(fakeAzureAccountKey.endsWith("==")).toBe(true);
    });

    it("has a well-formed 40-char AWS secret key fixture", () => {
      expect(fakeAwsSecretKey).toHaveLength(40);
    });

    it("detects and redacts an Azure Storage connection string", () => {
      const input = `config.connectionString = "${fakeAzureConnectionString}";`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "azure_connection_string");

      expect(match).toMatchObject({ category: "credential_like", risk: "high" });

      const redacted = redactSecrets(input);
      expect(redacted).not.toContain(fakeAzureAccountKey);
      expect(redacted).toContain("AccountKey=[REDACTED];");
      // Structure around the key is preserved for debuggability, mirroring database_url.
      expect(redacted).toContain("DefaultEndpointsProtocol=https;AccountName=agentforgestorage;");
      expect(redacted).toContain("EndpointSuffix=core.windows.net");
    });

    it("treats an obviously fake Azure connection string example as a local placeholder", () => {
      const placeholderKey = `${"x".repeat(86)}==`;
      const input = `DefaultEndpointsProtocol=https;AccountName=example;AccountKey=${placeholderKey};EndpointSuffix=core.windows.net`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "azure_connection_string");

      expect(match).toMatchObject({ category: "local_placeholder", risk: "low" });
    });

    it("detects and redacts a standalone Azure Storage account key", () => {
      const input = `AZURE_STORAGE_KEY=${fakeAzureAccountKey}`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "azure_storage_key");

      expect(match).toMatchObject({ category: "credential_like", risk: "high" });
      expect(redactSecrets(input)).not.toContain(fakeAzureAccountKey);
    });

    it("does not flag a shorter or non-padded base64 value as an Azure Storage account key", () => {
      // azure_storage_key requires the fixed 88-char length ending in "==";
      // a same-alphabet value of the wrong length or padding must not match,
      // proving the pattern is shape-specific rather than a generic catch-all.
      const tooShort = fakeAzureAccountKey.slice(0, 60);
      const noPadding = `${fakeAzureAccountKey.slice(0, 86)}AB`;

      expect(detectSecrets(`KEY=${tooShort}`).map((m) => m.kind)).not.toContain(
        "azure_storage_key"
      );
      expect(detectSecrets(`KEY=${noPadding}`).map((m) => m.kind)).not.toContain(
        "azure_storage_key"
      );
    });

    it("detects and redacts a Cloudflare API token", () => {
      const input = `CLOUDFLARE_API_TOKEN=${fakeCloudflareToken}`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "cloudflare_api_token");

      expect(match).toMatchObject({ category: "credential_like", risk: "high" });
      expect(redactSecrets(input)).not.toContain(fakeCloudflareToken);
    });

    it("does not flag an unprefixed 40-char token as a Cloudflare API token", () => {
      // Legacy (pre-2026) Cloudflare tokens have no fixed prefix and are
      // intentionally left to the high_entropy/api_key_assignment catch-alls
      // rather than a dedicated low-specificity pattern.
      const unprefixed = fakeCloudflareToken.replace(/^cfat_/, "");

      expect(detectSecrets(`CLOUDFLARE_API_TOKEN=${unprefixed}`).map((m) => m.kind)).not.toContain(
        "cloudflare_api_token"
      );
    });

    it("detects and redacts Twilio Account SID and API Key SID values", () => {
      const input = `TWILIO_ACCOUNT_SID=${fakeTwilioAccountSid}\nTWILIO_API_KEY=${fakeTwilioApiKeySid}`;

      const matches = detectSecrets(input);
      const sidMatches = matches.filter((m) => m.kind === "twilio_sid");

      expect(sidMatches).toHaveLength(2);
      expect(sidMatches[0]).toMatchObject({ category: "credential_like", risk: "high" });
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain(fakeTwilioAccountSid);
      expect(redacted).not.toContain(fakeTwilioApiKeySid);
    });

    it("does not flag a non-hex or wrong-length value as a Twilio SID", () => {
      // AC/SK SIDs are fixed-format (prefix + exactly 32 hex chars); a
      // same-length run of non-hex characters must not match.
      expect(
        detectSecrets(`TWILIO_ACCOUNT_SID=AC${"z".repeat(32)}`).map((m) => m.kind)
      ).not.toContain("twilio_sid");
    });

    it("detects and redacts a Twilio Auth Token when adjacent to its assignment context", () => {
      const input = `TWILIO_AUTH_TOKEN=${fakeTwilioAuthToken}`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "twilio_auth_token");

      expect(match).toMatchObject({ category: "credential_like", risk: "high" });
      expect(redactSecrets(input)).not.toContain(fakeTwilioAuthToken);
    });

    it("does not flag a bare 32-char hex string as a Twilio auth token without adjacent context", () => {
      const matches = detectSecrets(`content_hash=${fakeTwilioAuthToken}`);

      expect(matches.map((m) => m.kind)).not.toContain("twilio_auth_token");
    });

    it("treats a placeholder-shaped Twilio auth token assignment as a local placeholder", () => {
      const input = "twilio_auth_token=00000000000000000000000000000000";

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "twilio_auth_token");

      expect(match).toMatchObject({ category: "local_placeholder", risk: "low" });
    });

    it("detects and redacts an AWS secret access key when adjacent to its assignment context", () => {
      const input = `aws_secret_access_key=${fakeAwsSecretKey}`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "aws_secret_key");

      expect(match).toMatchObject({ category: "credential_like", risk: "high" });
      expect(redactSecrets(input)).not.toContain(fakeAwsSecretKey);
    });

    it("does not flag a bare 40-char base64-shaped string as an AWS secret key without adjacent context", () => {
      const matches = detectSecrets(`some_other_value=${fakeAwsSecretKey}`);

      expect(matches.map((m) => m.kind)).not.toContain("aws_secret_key");
    });

    it("treats a placeholder-shaped AWS secret key assignment as a local placeholder", () => {
      const input = `AWS_SECRET_ACCESS_KEY=${"x".repeat(40)}`;

      const matches = detectSecrets(input);
      const match = matches.find((m) => m.kind === "aws_secret_key");

      expect(match).toMatchObject({ category: "local_placeholder", risk: "low" });
    });
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
      "DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge\nAPI_KEY=placeholder-local-only-token\nBearer placeholder-local-only-token-123456";
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
        }),
        expect.objectContaining({
          kind: "bearer_token",
          category: "local_placeholder",
          risk: "low"
        })
      ])
    );
    expect(redactSecrets(input)).not.toContain("agentforge:agentforge");
    expect(redactSecrets(input)).not.toContain("placeholder-local-only-token");
  });

  it("keeps credential-bearing localhost database URLs high risk unless credentials are placeholders", () => {
    const matches = detectSecrets(
      [
        "DATABASE_URL=postgresql://service:prodSecret123456789@localhost:15432/app",
        "DATABASE_URL=postgresql://svc-prod-2026:svc-prod-2026@localhost:15432/app"
      ].join("\n")
    );

    const databaseMatches = matches.filter((match) => match.kind === "database_url");
    expect(databaseMatches).toHaveLength(2);
    expect(databaseMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "credential_like",
          risk: "high",
          localService: true
        })
      ])
    );
    expect(redactSecrets(matches[0]!.value)).not.toContain("prodSecret");
  });

  it("classifies spaced placeholder assignments before risk scoring", () => {
    const matches = detectSecrets("API_KEY = xxxxxxxxxxxxxxxxxxxx\nTOKEN = dev-local-token-123456");

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "api_key_assignment",
          category: "local_placeholder",
          risk: "low"
        })
      ])
    );
  });

  it("does not downgrade real assignment values", () => {
    const matches = detectSecrets("token=abcdefghijklmnopqrstuvwxyz1234567890");

    expect(matches.find((match) => match.kind === "api_key_assignment")).toMatchObject({
      category: "credential_like",
      risk: "high"
    });
  });

  it("removes source blobs and full diffs by default while preserving metadata", () => {
    const value = sanitizeForMetadataStorage({
      filename: "src/billing/checkout.ts",
      patch: `+ const token = '${rawGithubToken}'`,
      previousContent: "export const before = true;",
      currentContent: "export const after = true;",
      evidence: "Changed path matched billing policy"
    });

    expect(value).toEqual({
      filename: "src/billing/checkout.ts",
      evidence: "Changed path matched billing policy"
    });
    expect(JSON.stringify(value)).not.toContain("ghp_");
    expect(JSON.stringify(value)).not.toContain("export const");
  });

  it("retains redacted diffs only when diff retention is enabled", () => {
    const value = sanitizeForMetadataStorage(
      {
        patch: `+ token=${rawGithubToken}`,
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
          evidence: `token=${rawGithubToken}`,
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
          evidence: `token=${rawGithubToken}`,
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
      expect(prompt.prompt).not.toContain("ghp_");
    }
  });
});
