import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import type { AtomicTargetKind, AtomicWriteOperations } from "./main.js";

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function inspectTarget(path: string): AtomicTargetKind {
  try {
    return lstatSync(path).isFile() ? "file" : "unsupported";
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

/** Resolve lexical aliases and every symlink in the target's existing parent directory. */
export function canonicalizeAtomicTarget(path: string): string {
  const absoluteTarget = resolve(path);
  return join(realpathSync(dirname(absoluteTarget)), basename(absoluteTarget));
}

/** Real filesystem operations used by the CLI's transactional artifact writer. */
export function createNodeAtomicWriteOperations(): AtomicWriteOperations {
  return {
    canonicalPath: canonicalizeAtomicTarget,
    inspectTarget,
    temporaryPath: (targetPath, purpose) =>
      join(
        dirname(targetPath),
        `.${basename(targetPath)}.loom-${purpose}-${process.pid}-${randomUUID()}`
      ),
    writeExclusive: (path, content) =>
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" }),
    // A hard link is an atomic create-if-absent operation. Staged and backup
    // files live beside their target, so they are guaranteed to share a device.
    installExclusive: (sourcePath, targetPath) => linkSync(sourcePath, targetPath),
    rename: (sourcePath, targetPath) => renameSync(sourcePath, targetPath),
    remove: removeFile
  };
}
