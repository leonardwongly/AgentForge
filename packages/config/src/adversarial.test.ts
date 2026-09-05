import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

describe("runtime configuration adversarial values", () => {
  it.each(["maybe", "truthy", "2", "null"])(
    "rejects an unrecognized boolean value instead of silently coercing %s to false",
    (value) => {
      expect(() => loadConfig({ NODE_ENV: "development", REDACT_SECRETS: value })).toThrow(
        "expected a boolean value"
      );
    }
  );

  it("accepts documented boolean spellings with surrounding whitespace", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      REDACT_SECRETS: " YES ",
      LLM_FEATURES: "off",
      ALLOW_UNSIGNED_GITHUB_WEBHOOKS: "0"
    });

    expect(config.redactSecrets).toBe(true);
    expect(config.llmFeatures).toBe(false);
    expect(config.github.allowUnsignedWebhooks).toBe(false);
  });

  it("keeps blank boolean values on their documented defaults", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      REDACT_SECRETS: "",
      LLM_FEATURES: ""
    });

    expect(config.redactSecrets).toBe(true);
    expect(config.llmFeatures).toBe(false);
  });
});
