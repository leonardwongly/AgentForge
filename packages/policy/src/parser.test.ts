import { describe, expect, it } from "vitest";
import { MAX_POLICY_YAML_BYTES, parsePolicyYaml } from "./parser.js";

describe("policy YAML parser", () => {
  it("rejects unknown policy keys instead of silently dropping them", () => {
    const parsed = parsePolicyYaml(`
version: 1
agentforge:
  mode: enforce
unexpected: true
`);

    expect(parsed.errors.some((error) => error.includes("Unrecognized key"))).toBe(true);
    expect(parsed.config.agentforge.mode).toBe("enforce");
  });

  it("fails closed for malformed YAML", () => {
    const parsed = parsePolicyYaml("version: [1\n");

    expect(parsed.errors[0]).toMatch(/invalid YAML/i);
    expect(parsed.config.agentforge.mode).toBe("enforce");
  });

  it("bounds persisted policy size before parsing", () => {
    const parsed = parsePolicyYaml(`version: 1\ncomment: ${"x".repeat(MAX_POLICY_YAML_BYTES)}`);

    expect(parsed.errors[0]).toContain("exceeds");
    expect(parsed.config.agentforge.mode).toBe("enforce");
  });

  it("fails closed when a runtime boundary supplies a non-string value", () => {
    const parsed = parsePolicyYaml(null as unknown as string);

    expect(parsed.errors).toEqual(["policy YAML must be a string"]);
    expect(parsed.config.agentforge.mode).toBe("enforce");
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects excessive YAML aliases before expansion can exhaust resources", () => {
    const aliases = Array.from({ length: 101 }, () => "    - *anchor").join("\n");
    const parsed = parsePolicyYaml(`
version: 1
agentforge:
  mode: enforce
  apply_to:
    - &anchor pull_requests
${aliases}
`);

    expect(parsed.errors.join(" ")).toMatch(/alias|resource exhaustion/i);
    expect(parsed.config.agentforge.mode).toBe("enforce");
  });
});
