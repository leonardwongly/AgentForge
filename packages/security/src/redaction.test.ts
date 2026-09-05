import { describe, expect, it } from "vitest";
import {
  buildLlmAdvisoryPrompt,
  detectSecrets,
  redactObject,
  redactSecrets,
  sanitizeExternalMetadataText,
  sanitizeForMetadataStorage,
  summarizeSafeSnippet
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

  it("preserves content-bound policy versions as non-secret digest references", () => {
    const policyVersion = `fintech@1.0.0+${"a1".repeat(32)}`;

    expect(redactSecrets(policyVersion)).toBe(policyVersion);
    expect(redactObject({ policyVersion })).toEqual({ policyVersion });
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

  describe("adversarial redaction edge cases", () => {
    it("does not hang or blow up on many unterminated private-key markers (ReDoS guard)", () => {
      // Attacker-controlled input with thousands of BEGIN markers that never
      // close. The private_key pattern is bounded ({0,16384}? inner gap), so
      // scanning must stay linear-time and complete quickly instead of
      // degrading to O(n^2) backtracking.
      const marker = "-----" + "BEGIN RSA " + "PRIVATE KEY" + "-----\n";
      const input = marker.repeat(5000) + "-----END RSA " + "PRIVATE KEY" + "-----";

      const started = performance.now();
      const redacted = redactSecrets(input);
      const elapsed = performance.now() - started;

      // The single terminated marker is redacted; the unterminated markers are
      // left as ordinary text (correct behavior).
      expect(redacted).toContain("[REDACTED]");
      // Generous bound: a linear-time scan of ~150KB must finish well under
      // a second. If the pattern regressed to quadratic backtracking this
      // would blow far past it.
      expect(elapsed).toBeLessThan(2000);
    });

    it("detects secrets beyond the first scan chunk", () => {
      // Chunked scanning must not leave an unscanned tail where a credential
      // can hide, while redactSecrets still redacts the whole input.
      const secret = `ghp_${"1".repeat(36)}`;
      const padding = "a".repeat(70_000);
      const input = `${padding} token=${secret}`;

      expect(detectSecrets(input).some((m) => m.kind === "github_token")).toBe(true);
      expect(redactSecrets(input)).not.toContain(secret);
    });

    it("detects secrets near a chunk boundary", () => {
      const secret = `ghp_${"1".repeat(36)}`;
      const input = `${"a".repeat(60_000)} token=${secret}`;
      expect(detectSecrets(input).some((m) => m.kind === "github_token")).toBe(true);
    });

    it("detects a token that crosses the bounded scan chunk boundary", () => {
      const secret = `ghp_${"1".repeat(36)}`;
      const input = `${"a".repeat(65_531)} ${secret}`;

      expect(detectSecrets(input).some((match) => match.kind === "github_token")).toBe(true);
    });

    it("returns an empty string for non-positive or non-finite metadata maxLength", () => {
      expect(sanitizeExternalMetadataText("hello", 0)).toBe("");
      expect(sanitizeExternalMetadataText("hello", -5)).toBe("");
      expect(sanitizeExternalMetadataText("hello", Number.NaN)).toBe("");
      expect(sanitizeExternalMetadataText("hello", Number.POSITIVE_INFINITY)).toBe("");
    });

    it("truncates metadata by code point without splitting surrogate pairs", () => {
      // An astral-plane emoji is a single code point but two UTF-16 units.
      // Truncation must not split it into a lone surrogate.
      const emoji = "\u{1F600}"; // 😀
      const value = `ab${emoji}cd`;
      const truncated = sanitizeExternalMetadataText(value, 3);
      expect(truncated).toBe("ab" + emoji);
      expect([...truncated]).toHaveLength(3);
    });

    it("folds control characters and whitespace in metadata text", () => {
      const value = "a\u0000b\u0007c\t\nd   e";
      expect(sanitizeExternalMetadataText(value, 100)).toBe("a b c d e");
    });

    it("redacts secrets before folding whitespace in metadata text", () => {
      const value = `token=${rawGithubToken}   next`;
      const out = sanitizeExternalMetadataText(value, 100);
      expect(out).not.toContain("ghp_");
      expect(out).toContain("[REDACTED]");
    });

    it("redactObject leaves non-object primitives untouched", () => {
      expect(redactObject(null)).toBeNull();
      expect(redactObject(undefined)).toBeUndefined();
      expect(redactObject(42)).toBe(42);
      expect(redactObject(true)).toBe(true);
    });

    it("redactObject does not recurse into Date instances", () => {
      const date = new Date("2026-01-01T00:00:00.000Z");
      expect(redactObject(date)).toBe(date);
    });

    it("redactObject drops cyclic links so redaction remains JSON-safe", () => {
      const value: { safe: string; self?: unknown } = { safe: "value" };
      value.self = value;

      const redacted = redactObject(value);

      expect(redacted).toEqual({ safe: "value" });
      expect(() => JSON.stringify(redacted)).not.toThrow();
    });

    it("returns an empty snippet for a zero maxLength and never splits an emoji", () => {
      expect(summarizeSafeSnippet("secret", 0)).toBe("");
      expect(summarizeSafeSnippet("😀abc", 2)).toBe("😀…");
      expect([...summarizeSafeSnippet("😀abc", 2)]).toHaveLength(2);
    });

    it("truncates large Unicode input without materializing every code point", () => {
      const input = "😀".repeat(100_000);
      const snippet = summarizeSafeSnippet(input, 8);

      expect(snippet).toBe("😀😀😀😀😀😀😀…");
      expect([...snippet]).toHaveLength(8);
    });

    it("bounds metadata truncation for large Unicode input without splitting", () => {
      const input = "😀".repeat(100_000);
      const metadata = sanitizeExternalMetadataText(input, 8);

      expect(metadata).toBe("😀😀😀😀😀😀😀😀");
      expect([...metadata]).toHaveLength(8);
    });
  });
});
