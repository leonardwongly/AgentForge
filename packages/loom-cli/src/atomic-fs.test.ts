import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeAtomicWriteOperations } from "./atomic-fs.js";
import { createAtomicFileWriter } from "./main.js";

function withTemporaryDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "loom-atomic-write-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Node atomic file writes", () => {
  it("canonicalizes symlinked parent directories before duplicate-target checks", () => {
    withTemporaryDirectory((root) => {
      const realParent = join(root, "real");
      const aliasParent = join(root, "alias");
      mkdirSync(realParent);
      symlinkSync(realParent, aliasParent, "dir");
      const writer = createAtomicFileWriter(createNodeAtomicWriteOperations());

      expect(() =>
        writer([
          { path: join(realParent, "artifact.json"), content: "first" },
          { path: join(aliasParent, "artifact.json"), content: "second" }
        ])
      ).toThrow(/duplicate target/);

      expect(readdirSync(realParent)).toEqual([]);
      expect(existsSync(join(realParent, "artifact.json"))).toBe(false);
    });
  });

  it("uses an exclusive install primitive that cannot replace an existing target", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      const staged = join(root, "staged");
      const target = join(root, "target");
      writeFileSync(staged, "new artifact", "utf8");
      writeFileSync(target, "concurrent artifact", "utf8");

      expect(() => operations.installExclusive(staged, target)).toThrow();
      expect(readFileSync(target, "utf8")).toBe("concurrent artifact");
      expect(readFileSync(staged, "utf8")).toBe("new artifact");
    });
  });

  it("inspects a missing path as missing and a regular file as a file", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      const missing = join(root, "does-not-exist");
      const file = join(root, "existing.txt");
      writeFileSync(file, "x", "utf8");

      expect(operations.inspectTarget(missing)).toBe("missing");
      expect(operations.inspectTarget(file)).toBe("file");
    });
  });

  it("reports a directory target as unsupported", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      expect(operations.inspectTarget(root)).toBe("unsupported");
    });
  });

  it("canonicalizes the target through a symlinked parent directory", () => {
    withTemporaryDirectory((root) => {
      const realParent = join(root, "real");
      const aliasParent = join(root, "alias");
      mkdirSync(realParent);
      symlinkSync(realParent, aliasParent, "dir");
      const operations = createNodeAtomicWriteOperations();

      // realpathSync also resolves the OS tempdir symlink (e.g. /tmp ->
      // /private/tmp on macOS), so compare against the resolved real parent.
      expect(operations.canonicalPath(join(aliasParent, "a.json"))).toBe(
        join(realpathSync(realParent), "a.json")
      );
    });
  });

  it("generates a unique temporary path per call for each purpose", () => {
    const operations = createNodeAtomicWriteOperations();
    const a = operations.temporaryPath("/tmp/target.json", "staged");
    const b = operations.temporaryPath("/tmp/target.json", "staged");
    const c = operations.temporaryPath("/tmp/target.json", "backup");

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("/tmp/.target.json.loom-staged-")).toBe(true);
    expect(c.startsWith("/tmp/.target.json.loom-backup-")).toBe(true);
  });

  it("writeExclusive refuses to overwrite an existing file (wx flag)", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      const path = join(root, "existing.txt");
      writeFileSync(path, "original", "utf8");

      expect(() => operations.writeExclusive(path, "new")).toThrow();
      expect(readFileSync(path, "utf8")).toBe("original");
    });
  });

  it("remove ignores a missing file (ENOENT is not an error)", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      expect(() => operations.remove(join(root, "missing"))).not.toThrow();
    });
  });

  it("rename moves a file and remove deletes it", () => {
    withTemporaryDirectory((root) => {
      const operations = createNodeAtomicWriteOperations();
      const source = join(root, "source.txt");
      const target = join(root, "target.txt");
      writeFileSync(source, "payload", "utf8");

      operations.rename(source, target);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("payload");

      operations.remove(target);
      expect(existsSync(target)).toBe(false);
    });
  });
});
