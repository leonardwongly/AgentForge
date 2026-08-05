import { describe, expect, it } from "vitest";

import { facetFromAttributes, matchesGitAttributePattern, parseGitAttributes } from "./gitattributes.js";

describe("parseGitAttributes", () => {
  it("parses text and -text patterns, ignoring comments and blanks", () => {
    const attrs = parseGitAttributes([
      "# comment",
      "*.png -text",
      "*.md text",
      "",
      "docs/** text"
    ].join("\n"));
    expect(attrs.binaryPaths).toEqual(["*.png"]);
    expect(attrs.textPaths).toEqual(["*.md", "docs/**"]);
  });
});

describe("matchesGitAttributePattern", () => {
  it("matches exact, prefixed, and glob patterns", () => {
    expect(matchesGitAttributePattern("*.png", "logo.png")).toBe(true);
    expect(matchesGitAttributePattern("*.png", "logo.txt")).toBe(false);
    expect(matchesGitAttributePattern("src/", "src/app.ts")).toBe(true);
    expect(matchesGitAttributePattern("docs/**", "docs/guide.md")).toBe(true);
  });
});

describe("facetFromAttributes", () => {
  it("forces bytes for -text and text for text patterns", () => {
    const attrs = parseGitAttributes("*.png -text\n*.md text");
    expect(facetFromAttributes(attrs, "logo.png")).toBe("bytes");
    expect(facetFromAttributes(attrs, "README.md")).toBe("text");
    expect(facetFromAttributes(attrs, "src/app.ts")).toBeUndefined();
  });
});
