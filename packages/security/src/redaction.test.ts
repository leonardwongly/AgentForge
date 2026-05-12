import { describe, expect, it } from "vitest";
import { detectSecrets, redactObject, redactSecrets } from "./index.js";

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
  });
});
