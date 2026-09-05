import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Cell, State } from "@agentforge/loom-core";
import { stateToGitWorkingCopy } from "./export.js";

function stateFor(path: string, cell: Cell): State {
  return {
    kind: "state" as const,
    cells: { [path]: cell }
  };
}

describe("Git export adversarial input handling", () => {
  it("does not silently truncate or reinterpret malformed bytes-cell base64", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-export-invalid-base64-"));
    try {
      const report = stateToGitWorkingCopy(
        stateFor("payload.bin", {
          facet: "bytes",
          ident: "nid:invalid" as never,
          text: "a!$"
        }),
        root
      );

      expect(report.written).toBe(0);
      expect(report.losses).toEqual([
        { path: "payload.bin", reason: "bytes cell is not valid base64" }
      ]);
      expect(existsSync(join(root, "payload.bin"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an empty bytes cell while rejecting malformed padding", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-export-base64-boundaries-"));
    try {
      const emptyReport = stateToGitWorkingCopy(
        stateFor("empty.bin", {
          facet: "bytes",
          ident: "nid:empty" as never,
          text: ""
        }),
        root
      );
      expect(emptyReport).toEqual({ written: 1, losses: [] });
      expect(readFileSync(join(root, "empty.bin"))).toEqual(Buffer.alloc(0));

      const badReport = stateToGitWorkingCopy(
        stateFor("bad.bin", {
          facet: "bytes",
          ident: "nid:bad" as never,
          text: "ab=c"
        }),
        root
      );
      expect(badReport.losses[0]?.reason).toBe("bytes cell is not valid base64");
      expect(existsSync(join(root, "bad.bin"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid modes rather than coercing NaN or foreign file types", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-export-invalid-mode-"));
    try {
      const report = stateToGitWorkingCopy(
        stateFor("script.sh", {
          facet: "text",
          ident: "nid:mode" as never,
          text: "#!/bin/sh\n",
          mode: Number.NaN
        }),
        root
      );
      expect(report.written).toBe(1);
      expect(report.losses).toEqual([{ path: "script.sh", reason: "cannot set mode NaN" }]);
      expect(readFileSync(join(root, "script.sh"), "utf8")).toBe("#!/bin/sh\n");

      const foreignType = stateToGitWorkingCopy(
        stateFor("link", {
          facet: "text",
          ident: "nid:link" as never,
          text: "target",
          mode: 0o120777
        }),
        root
      );
      expect(foreignType.losses).toEqual([{ path: "link", reason: "cannot set mode 41471" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
