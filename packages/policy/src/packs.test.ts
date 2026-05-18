import { describe, expect, it } from "vitest";
import { builtinPolicyPacks } from "./packs.js";
import { parsePolicyYaml } from "./parser.js";

describe("built-in policy packs", () => {
  it("use unique ids and valid embedded YAML", () => {
    const ids = builtinPolicyPacks.map((pack) => pack.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const pack of builtinPolicyPacks) {
      const parsed = parsePolicyYaml(pack.contentYaml);

      expect(parsed.errors).toEqual([]);
      expect(parsed.config.policy_pack_id).toBe(pack.id);
      expect(parsed.config.policy_pack_version).toBe(pack.version);
      expect(parsed.config.agentforge.mode).toBe(pack.defaultMode);
    }
  });

  it("keep shipped packs metadata-only and redacted by default", () => {
    for (const pack of builtinPolicyPacks) {
      const parsed = parsePolicyYaml(pack.contentYaml);

      expect(parsed.errors).toEqual([]);
      expect(parsed.config.data_retention).toMatchObject({
        source_code_storage: false,
        full_diff_retention: "disabled",
        redact_secrets: true,
        llm_features: false
      });
    }
  });

  it("preserves enforce semantics only for enforce-ready packs", () => {
    const enforceReadyPackIds = builtinPolicyPacks
      .filter((pack) => pack.defaultMode === "enforce")
      .map((pack) => pack.id);

    expect(enforceReadyPackIds).toEqual(["enterprise-strict"]);
  });
});
