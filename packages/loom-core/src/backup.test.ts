import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileObjectStore } from "./store.js";

function withRoots(run: (root: string, backup: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "loom-backup-"));
  const backup = mkdtempSync(join(tmpdir(), "loom-backup-dst-"));
  try {
    run(root, backup);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
}

describe("backup / restore / recovery", () => {
  it("backs up objects and restores them after loss", () => {
    withRoots((root, backup) => {
      const store = new FileObjectStore(root);
      const cid = store.putRaw(new TextEncoder().encode("important"));
      store.backupTo(backup);

      // Simulate loss/corruption: delete the object.
      store.delete(cid);
      expect(store.hasRaw(cid)).toBe(false);

      store.restoreFrom(backup);
      expect(store.hasRaw(cid)).toBe(true);
      expect(new Uint8Array(store.getRaw(cid)!)).toEqual(new TextEncoder().encode("important"));
    });
  });

  it("backs up dag-cbor and legacy objects too", () => {
    withRoots((root, backup) => {
      const store = new FileObjectStore(root);
      const dagCid = store.putDagCbor({ kind: "loom.state", schema: 1, x: 1 });
      const legacyCid = store.put({ a: 1 });
      store.backupTo(backup);

      store.delete(dagCid);
      store.delete(legacyCid);
      store.restoreFrom(backup);

      expect(store.getDagCbor(dagCid)).toEqual({ kind: "loom.state", schema: 1, x: 1 });
      expect(store.get(legacyCid)).toEqual({ a: 1 });
    });
  });

  it("recover() removes orphaned temp files left by a crash", () => {
    withRoots((root, _backup) => {
      const store = new FileObjectStore(root);
      // Simulate a crash between write and rename: an orphaned temp file.
      writeFileSync(join(root, "objects", ".orphan.1.tmp"), "partial", "utf8");
      writeFileSync(join(root, "objects", ".orphan.2.tmp"), "partial", "utf8");
      const cid = store.putRaw(new TextEncoder().encode("real"));

      store.recover();
      // Temp files gone; real object intact.
      expect(store.hasRaw(cid)).toBe(true);
      expect(store.listCids()).toEqual([cid]);
    });
  });

  it("restores into a fresh store from a backup", () => {
    withRoots((root, backup) => {
      const source = new FileObjectStore(root);
      const cid = source.putRaw(new TextEncoder().encode("data"));
      source.backupTo(backup);

      // A brand-new store (fresh root) restored from the backup.
      const freshRoot = mkdtempSync(join(tmpdir(), "loom-backup-fresh-"));
      try {
        const fresh = new FileObjectStore(freshRoot);
        fresh.restoreFrom(backup);
        expect(new Uint8Array(fresh.getRaw(cid)!)).toEqual(new TextEncoder().encode("data"));
      } finally {
        rmSync(freshRoot, { recursive: true, force: true });
      }
    });
  });
});
