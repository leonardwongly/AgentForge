import { describe, expect, it } from "vitest";

import {
  facetFromAttributes,
  filterForPath,
  matchesGitAttributePattern,
  parseGitAttributes
} from "./gitattributes.js";

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

  it("uses the last matching text declaration, as Git attributes require", () => {
    const attrs = parseGitAttributes("*.dat text\n*.dat -text\n");
    expect(facetFromAttributes(attrs, "payload.dat")).toBe("bytes");
  });

  it("allows a later broad rule to override an earlier specific rule", () => {
    const attrs = parseGitAttributes("secret.env -text\n*.env text\n");
    expect(facetFromAttributes(attrs, "secret.env")).toBe("text");
  });
});

describe("filter attributes (item #5)", () => {
  it("parses filter=<name> attributes", () => {
    const attrs = parseGitAttributes("*.secret filter=loom\n*.bin filter=compress");
    expect(attrs.filterPaths).toEqual([
      { pattern: "*.secret", filter: "loom" },
      { pattern: "*.bin", filter: "compress" }
    ]);
  });

  it("parses a bare filter attribute as an empty-name filter", () => {
    const attrs = parseGitAttributes("*.secret filter");
    expect(attrs.filterPaths).toEqual([{ pattern: "*.secret", filter: "" }]);
  });

  it("resolves the filter name for a matching path", () => {
    const attrs = parseGitAttributes("*.secret filter=loom");
    expect(filterForPath(attrs, "config/foo.secret")).toBe("loom");
    expect(filterForPath(attrs, "src/app.ts")).toBeUndefined();
  });

  it("uses the last matching filter declaration", () => {
    const attrs = parseGitAttributes("*.secret filter=first\n*.secret filter=last\n");
    expect(filterForPath(attrs, "config.secret")).toBe("last");
  });

  it("combines text, -text, and filter attributes on one line", () => {
    const attrs = parseGitAttributes("*.secret filter=loom -text");
    expect(attrs.binaryPaths).toEqual(["*.secret"]);
    expect(attrs.filterPaths).toEqual([{ pattern: "*.secret", filter: "loom" }]);
  });
});
