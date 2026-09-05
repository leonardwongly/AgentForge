import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeIdent } from "@agentforge/loom-core";
import { describe, expect, it } from "vitest";

import { initRepo, proposeRepo } from "./native.js";
import {
  mirrorHeadState,
  restoreDrill,
  stateEquivalenceDigest,
  verifyMirrorEquivalence
} from "./pilot.js";

function runGit(repoDir: string, args: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
}

function initGitRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "loom-pilot-git-"));
  runGit(repoDir, ["init", "--quiet"]);
  return repoDir;
}

/** Create a Loom repo with one committed change. */
async function makeLoomRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-pilot-repo-"));
  writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
  initRepo(dir);
  writeFileSync(join(dir, "a.txt"), "changed\n", "utf8");
  await proposeRepo(dir, "update a");
  return dir;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stateEquivalenceDigest", () => {
  it("is deterministic and content-only (idents do not matter)", () => {
    const a = {
      kind: "state" as const,
      cells: { "x.txt": { facet: "text" as const, ident: "nid:a" as NodeIdent, text: "hi\n" } }
    };
    const b = {
      kind: "state" as const,
      cells: {
        "x.txt": { facet: "text" as const, ident: "nid:different" as NodeIdent, text: "hi\n" }
      }
    };
    expect(stateEquivalenceDigest(a)).toBe(stateEquivalenceDigest(b));
    const c = {
      kind: "state" as const,
      cells: { "x.txt": { facet: "text" as const, ident: "nid:a" as NodeIdent, text: "bye\n" } }
    };
    expect(stateEquivalenceDigest(a)).not.toBe(stateEquivalenceDigest(c));
  });
});

describe("pilot mirror and verify", () => {
  it("mirrors the head State to git and verifies byte-exact equivalence", async () => {
    const loom = await makeLoomRepo();
    const git = initGitRepo();
    try {
      const result = await mirrorHeadState(loom, git, "pilot mirror 1");
      expect(result.equivalent).toBe(true);
      expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
      expect(result.loomDigest).toBe(result.gitDigest);
      // The mirror ledger recorded the digest.
      expect(existsSync(join(loom, ".loom", "mirror.jsonl"))).toBe(true);

      const verify = await verifyMirrorEquivalence(loom, git);
      expect(verify.equivalent).toBe(true);
      expect(readFileSync(join(git, "a.txt"), "utf8")).toBe("changed\n");
    } finally {
      cleanup(loom, git);
    }
  });

  it("detects divergence when the git tree content differs", async () => {
    const loom = await makeLoomRepo();
    const git = initGitRepo();
    try {
      await mirrorHeadState(loom, git, "pilot mirror 1");
      // Tamper with the mirror: change a tracked file and commit it.
      writeFileSync(join(git, "a.txt"), "tampered\n", "utf8");
      runGit(git, ["add", "--all"]);
      runGit(git, [
        "-c",
        "user.name=Tamper",
        "-c",
        "user.email=tamper@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "--message",
        "tamper"
      ]);

      const verify = await verifyMirrorEquivalence(loom, git);
      expect(verify.equivalent).toBe(false);
      expect(
        verify.divergences.some((d) => d.path === "a.txt" && d.reason === "content differs")
      ).toBe(true);
      expect(verify.loomDigest).not.toBe(verify.gitDigest);
    } finally {
      cleanup(loom, git);
    }
  });

  it("detects divergence when a path is missing from the mirror", async () => {
    const loom = await makeLoomRepo();
    const git = initGitRepo();
    try {
      await mirrorHeadState(loom, git, "pilot mirror 1");
      // Remove a file from the mirror and commit the deletion.
      rmSync(join(git, "a.txt"));
      runGit(git, ["add", "--all"]);
      runGit(git, [
        "-c",
        "user.name=Tamper",
        "-c",
        "user.email=tamper@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "--message",
        "remove"
      ]);
      const verify = await verifyMirrorEquivalence(loom, git);
      expect(verify.equivalent).toBe(false);
      expect(verify.divergences.some((d) => d.reason === "missing from git mirror")).toBe(true);
    } finally {
      cleanup(loom, git);
    }
  });
});

describe("pilot restore drill", () => {
  it("backs up and clean-room restores the head, Line heads, and ledger", async () => {
    const loom = await makeLoomRepo();
    const backup = mkdtempSync(join(tmpdir(), "loom-pilot-backup-"));
    try {
      const result = restoreDrill(loom, backup);
      expect(result.ok).toBe(true);
      expect(result.headReproduced).toBe(true);
      expect(result.linesVerified).toBeGreaterThan(0);
      expect(result.ledgerValid).toBe(true);
    } finally {
      cleanup(loom, backup);
    }
  });

  it("fails the drill when the ledger is tampered", async () => {
    const loom = await makeLoomRepo();
    const backup = mkdtempSync(join(tmpdir(), "loom-pilot-backup-"));
    try {
      // Tamper with the admission ledger so verification must fail.
      const ledgerPath = join(loom, ".loom", "ledger.jsonl");
      writeFileSync(
        ledgerPath,
        readFileSync(ledgerPath, "utf8") + '{"index":999,"payload":{"tampered":true}}\n',
        "utf8"
      );
      const result = restoreDrill(loom, backup);
      expect(result.ok).toBe(false);
      expect(result.ledgerValid).toBe(false);
    } finally {
      cleanup(loom, backup);
    }
  });
});
