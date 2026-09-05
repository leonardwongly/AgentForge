import { describe, expect, it } from "vitest";

import { filterForPath, parseGitAttributes } from "./gitattributes.js";

describe(".gitattributes adversarial precedence", () => {
  it("honors a later -filter declaration instead of reporting a stale filter", () => {
    const attributes = parseGitAttributes("*.secret filter=decrypt\n*.secret -filter\n");

    expect(filterForPath(attributes, "config.secret")).toBeUndefined();
  });

  it("allows a later filter to re-enable a path after an unset", () => {
    const attributes = parseGitAttributes(
      "*.secret filter=decrypt\n*.secret -filter\nconfig.secret filter=encrypt\n"
    );

    expect(filterForPath(attributes, "config.secret")).toBe("encrypt");
    expect(filterForPath(attributes, "other.secret")).toBeUndefined();
  });
});
