import type { GitReader } from "@agentforge/loom-git-bridge";
import { describe, expect, it } from "vitest";
import { main, type CliIo } from "./main.js";

interface Sink {
  readonly out: string[];
  readonly err: string[];
}

function makeIo(files: Record<string, string>, sink: Sink): CliIo {
  return {
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    writeFile: (path, content) => {
      files[path] = content;
    },
    makeReader: (): GitReader => ({
      lsTree: (ref) =>
        Promise.resolve(
          ref === "head" ? [{ path: "README.md", mode: "100644", type: "blob" as const }] : []
        ),
      readFile: () => Promise.resolve("# hello\n")
    }),
    log: (message) => sink.out.push(message),
    error: (message) => sink.err.push(message)
  };
}

const warnPolicy = "version: 1\nagentforge:\n  mode: warn\n  apply_to:\n    - all_pull_requests\n";

describe("loom CLI main", () => {
  it("ratify prints a decision and returns 0 for a passing change", async () => {
    const files: Record<string, string> = { "policy.yaml": warnPolicy };
    const sink: Sink = { out: [], err: [] };
    const code = await main(
      ["ratify", "--repo", ".", "--base", "base", "--head", "head", "--policy", "policy.yaml"],
      makeIo(files, sink)
    );
    expect(code).toBe(0);
    expect(sink.out.join("\n")).toContain("decision: PASS");
  });

  it("returns usage error (2) for an unknown command", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["frobnicate"], makeIo({}, sink));
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("usage:");
  });

  it("returns 2 when a required flag is missing", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["ratify", "--repo", "."], makeIo({}, sink));
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("missing required");
  });

  it("prints usage and returns 0 for help", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["help"], makeIo({}, sink));
    expect(code).toBe(0);
    expect(sink.err.join("\n")).toContain("usage:");
  });
});
