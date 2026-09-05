import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyOps, emptyState, mintNodeIdent, type Cid, type State } from "@agentforge/loom-core";
import { describe, expect, it } from "vitest";
import { exportStateToGit, stateToGitWorkingCopy } from "./export.js";

const T0 = "loom:sha256:genesis" as Cid;

function requireState(ops: Parameters<typeof applyOps>[1]): State {
  const result = applyOps(emptyState(), ops);
  if (!result.ok) {
    throw new Error(`setup applyOps failed: ${result.error.detail}`);
  }
  return result.state;
}

function runGit(repoDir: string, args: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
}

async function initGitRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "loom-export-"));
  runGit(repoDir, ["init", "--quiet"]);
  return repoDir;
}

describe("stateToGitWorkingCopy (pure export)", () => {
  it("writes text and bytes cells, preserving content and modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-export-wc-"));
    try {
      const state = requireState([
        {
          op: "put_cell",
          at: "src/app.ts",
          ident: mintNodeIdent(T0, 0, "src/app.ts"),
          facet: "text",
          text: "export const v = 1;\n",
          mode: 0o100644
        },
        {
          op: "put_cell",
          at: "bin/run",
          ident: mintNodeIdent(T0, 1, "bin/run"),
          facet: "text",
          text: "#!/bin/sh\necho hi\n",
          mode: 0o100755
        },
        {
          op: "put_cell",
          at: "assets/icon.bin",
          ident: mintNodeIdent(T0, 2, "assets/icon.bin"),
          facet: "bytes",
          text: Buffer.from([0, 1, 2, 0xff]).toString("base64")
        }
      ]);
      const report = stateToGitWorkingCopy(state, dir);
      expect(report.written).toBe(3);
      expect(report.losses).toHaveLength(0);

      expect(await readFile(join(dir, "src", "app.ts"), "utf8")).toBe("export const v = 1;\n");
      expect(await readFile(join(dir, "bin", "run"), "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect(Buffer.from(await readFile(join(dir, "assets", "icon.bin")))).toEqual(
        Buffer.from([0, 1, 2, 0xff])
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports unsafe paths as losses instead of writing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-export-unsafe-"));
    try {
      const state = requireState([
        { op: "put_cell", at: "ok.txt", ident: mintNodeIdent(T0, 0, "ok.txt"), facet: "text", text: "fine" },
        { op: "put_cell", at: "../escape.txt", ident: mintNodeIdent(T0, 1, "escape"), facet: "text", text: "bad" }
      ]);
      const report = stateToGitWorkingCopy(state, dir);
      expect(report.written).toBe(1);
      expect(report.losses).toHaveLength(1);
      expect(report.losses[0]?.path).toBe("../escape.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports symlink targets as losses instead of following them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-export-symlink-"));
    const outside = join(dir, "..", "loom-export-outside.txt");
    try {
      await writeFile(outside, "keep", "utf8");
      await symlink(outside, join(dir, "output.txt"));
      const state = requireState([
        {
          op: "put_cell",
          at: "output.txt",
          ident: mintNodeIdent(T0, 0, "output.txt"),
          facet: "text",
          text: "overwrite"
        }
      ]);
      const report = stateToGitWorkingCopy(state, dir);
      expect(report.written).toBe(0);
      expect(report.losses[0]?.path).toBe("output.txt");
      expect(await readFile(outside, "utf8")).toBe("keep");
    } finally {
      await rm(outside, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never materializes Git metadata or hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-export-git-meta-"));
    try {
      const state = requireState([
        {
          op: "put_cell",
          at: ".git/hooks/pre-commit",
          ident: mintNodeIdent(T0, 0, "pre-commit"),
          facet: "text",
          text: "#!/bin/sh\ntouch escaped-hook\n"
        }
      ]);
      const report = stateToGitWorkingCopy(state, dir);
      expect(report.written).toBe(0);
      expect(report.losses[0]?.reason).toMatch(/Git metadata/);
      expect(existsSync(join(dir, ".git"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportStateToGit (mirror commit)", () => {
  it("commits a State to a git repository and returns the commit OID", async () => {
    const repoDir = await initGitRepo();
    try {
      const state = requireState([
        { op: "put_cell", at: "README.md", ident: mintNodeIdent(T0, 0, "README.md"), facet: "text", text: "# exported\n" }
      ]);
      const result = exportStateToGit(state, repoDir, { message: "mirror admission" });
      expect(result.written).toBe(1);
      expect(result.losses).toHaveLength(0);
      expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
      expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("# exported\n");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("reports losses while still committing the valid subset", async () => {
    const repoDir = await initGitRepo();
    try {
      const state = requireState([
        { op: "put_cell", at: "ok.txt", ident: mintNodeIdent(T0, 0, "ok.txt"), facet: "text", text: "fine" },
        { op: "put_cell", at: "../escape.txt", ident: mintNodeIdent(T0, 1, "escape"), facet: "text", text: "bad" }
      ]);
      const result = exportStateToGit(state, repoDir, { message: "partial mirror" });
      expect(result.written).toBe(1);
      expect(result.losses).toHaveLength(1);
      expect(await readFile(join(repoDir, "ok.txt"), "utf8")).toBe("fine");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("disables repository hooks during mirror commits", async () => {
    const repoDir = await initGitRepo();
    try {
      const hook = join(repoDir, ".git", "hooks", "pre-commit");
      const marker = join(repoDir, "hook-ran.txt");
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, "utf8");
      await chmod(hook, 0o755);
      const state = requireState([
        { op: "put_cell", at: "README.md", ident: mintNodeIdent(T0, 0, "README.md"), facet: "text", text: "# exported\n" }
      ]);
      exportStateToGit(state, repoDir, { message: "hook isolation" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
