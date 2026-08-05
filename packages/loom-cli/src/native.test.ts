import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { initRepo, logRepo, proposeRepo, statusRepo } from "./native.js";

function withRepo(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loom-native-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("native loom commands", () => {
  it("init creates a .loom store and head", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      const out = initRepo(dir);
      expect(out).toMatch(/^initialized: head /);
      expect(existsSync(join(dir, ".loom", "head"))).toBe(true);
      expect(initRepo(dir)).toBe("already initialized");
    });
  });

  it("status reports a clean working copy after init", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      initRepo(dir);
      expect(statusRepo(dir)).toBe("working copy clean");
    });
  });

  it("status reports added/modified/removed after edits", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      writeFileSync(join(dir, "b.txt"), "b", "utf8");
      initRepo(dir);

      writeFileSync(join(dir, "a.txt"), "changed", "utf8");
      writeFileSync(join(dir, "c.txt"), "new", "utf8");
      rmSync(join(dir, "b.txt"));

      const status = statusRepo(dir);
      expect(status).toContain("M a.txt");
      expect(status).toContain("A c.txt");
      expect(status).toContain("D b.txt");
    });
  });

  it("propose commits changes, updates head, and records the ledger", async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      initRepo(dir);
      const headBefore = readFileSync(join(dir, ".loom", "head"), "utf8");

      writeFileSync(join(dir, "a.txt"), "changed", "utf8");
      const out = await proposeRepo(dir, "update a");
      expect(out).toMatch(/^committed /);
      expect(readFileSync(join(dir, ".loom", "head"), "utf8")).not.toBe(headBefore);
      expect(statusRepo(dir)).toBe("working copy clean");
      expect(logRepo(dir)).toContain("update a");
    });
  });

  it("propose with no changes is a no-op", async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      initRepo(dir);
      expect(await proposeRepo(dir, "nothing")).toBe("no changes to propose");
    });
  });

  it("log reports a valid ledger", async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, "a.txt"), "hello", "utf8");
      initRepo(dir);
      writeFileSync(join(dir, "a.txt"), "v2", "utf8");
      await proposeRepo(dir, "first");
      writeFileSync(join(dir, "a.txt"), "v3", "utf8");
      await proposeRepo(dir, "second");
      const log = logRepo(dir);
      expect(log).toContain("first");
      expect(log).toContain("second");
      expect(log).toContain("ledger valid");
    });
  });

  it("status and propose fail cleanly outside a repository", async () => {
    await withRepo(async (dir) => {
      expect(statusRepo(dir)).toMatch(/not a Loom repository/);
      expect(await proposeRepo(dir, "x")).toMatch(/not a Loom repository/);
    });
  });
});
