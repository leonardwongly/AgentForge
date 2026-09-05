import { describe, expect, it } from "vitest";
import { recordHref, repositoryHref } from "./navigation";

describe("internal navigation URL builders", () => {
  it("encodes opaque record identifiers as one path segment", () => {
    expect(recordHref("record/with?reserved#chars")).toBe(
      "/records/record%2Fwith%3Freserved%23chars"
    );
  });

  it("encodes repository identifiers while preserving the fixed route suffix", () => {
    expect(repositoryHref("owner/name", "policy-preview")).toBe(
      "/repositories/owner%2Fname/policy-preview"
    );
  });
});
