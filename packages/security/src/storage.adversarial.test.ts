import { describe, expect, it } from "vitest";
import { sanitizeForMetadataStorage } from "./storage.js";

describe("metadata storage adversarial values", () => {
  it("drops cyclic references instead of overflowing the stack or breaking JSON serialization", () => {
    const value: { label: string; self?: unknown } = { label: "safe" };
    value.self = value;

    const sanitized = sanitizeForMetadataStorage(value);

    expect(sanitized).toEqual({ label: "safe" });
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("preserves repeated non-cyclic references while removing source blobs", () => {
    const shared = { content: "confidential source", label: "safe" };
    const sanitized = sanitizeForMetadataStorage({ first: shared, second: shared });

    expect(sanitized).toEqual({
      first: { label: "safe" },
      second: { label: "safe" }
    });
  });

  it("omits an object when a proxy rejects reflective enumeration", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("enumeration denied");
        }
      }
    );

    expect(sanitizeForMetadataStorage({ metadata: hostile })).toEqual({});
  });
});
