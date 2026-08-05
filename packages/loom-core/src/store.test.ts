import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { address, cellAddress } from "./addressing.js";
import { FileLineJournal, FileObjectStore } from "./store.js";
import type { Cell, Cid, NodeIdent } from "./types.js";

const CID = "loom:sha256:0000000000000000000000000000000000000000000000000000000000000000" as Cid;

async function withTemporaryRoot(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "loom-store-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("FileObjectStore (content-addressed, crash-safe)", () => {
  it("round-trips a value and returns its content address", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      const value = { kind: "state", cells: { "a.ts": { facet: "text", ident: "n1", text: "x" } } };
      const cid = store.put(value);
      expect(cid).toMatch(/^loom:sha256:[0-9a-f]{64}$/u);
      expect(store.get(cid)).toEqual(value);
      expect(store.has(cid)).toBe(true);
    });
  });

  it("deduplicates identical content to the same CID and a single file", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      const value = { a: 1, b: [1, 2, 3] };
      const first = store.put(value);
      const second = store.put(value);
      expect(first).toBe(second);
      // Only one object file exists (no duplicates).
      const files = readdirSync(join(root, "objects")).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
    });
  });

  it("returns undefined for absent and corrupt objects", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      expect(store.get(CID)).toBeUndefined();
      expect(store.has(CID)).toBe(false);

      // Write a corrupt (non-JSON) file under a CID and confirm it is rejected.
      writeFileSync(join(root, "objects", `${CID}.json`), "not json{", "utf8");
      expect(store.get(CID)).toBeUndefined();
    });
  });

  it("rejects a file whose bytes do not match its requested CID", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      const value = { payload: "hello" };
      const cid = store.put(value);
      // Tamper with the stored bytes so they no longer hash to the CID.
      writeFileSync(join(root, "objects", `${cid}.json`), JSON.stringify({ payload: "tampered" }), "utf8");
      expect(store.get(cid)).toBeUndefined();
    });
  });

  it("stores Cell and State objects that round-trip through addressing", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      const cell: Cell = { facet: "text", ident: "n1" as NodeIdent, text: "export const a = 1;" };
      const cid = store.put(cell);
      expect(store.get<Cell>(cid)).toEqual(cell);
      expect(cellAddress(store.get<Cell>(cid)!)).toBe(cid);
    });
  });

  it("leaves no temp files behind after a successful put", () => {
    withTemporaryRoot((root) => {
      const store = new FileObjectStore(root);
      store.put({ x: 1 });
      const temps = readdirSync(join(root, "objects")).filter((f) => f.endsWith(".tmp"));
      expect(temps).toHaveLength(0);
    });
  });
});

describe("FileLineJournal (transactional CAS + idempotency)", () => {
  const genesisHead = address({ kind: "line", name: "main", scope: "shared", head: CID });

  it("creates a Line genesis at sequence 0", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      expect(journal.read("main")).toBeUndefined();

      const outcome = await journal.advance({
        name: "main",
        scope: "shared",
        expectedHead: genesisHead,
        expectedSequence: 0,
        newHead: address({ v: 1 })
      });
      expect(outcome).toMatchObject({ ok: true, applied: true });
      if (outcome.ok) {
        expect(outcome.entry).toMatchObject({ name: "main", scope: "shared", sequence: 0 });
      }
      expect(journal.read("main")?.sequence).toBe(0);
    });
  });

  it("advances a Line and leases (head, sequence) on each update", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      const head1 = address({ v: 1 });
      const head2 = address({ v: 2 });
      const head3 = address({ v: 3 });

      await journal.advance({ name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: head1 });
      const second = await journal.advance({ name: "main", scope: "shared", expectedHead: head1, expectedSequence: 0, newHead: head2 });
      expect(second).toMatchObject({ ok: true, applied: true });
      if (second.ok) {
        expect(second.entry).toMatchObject({ head: head2, sequence: 1 });
      }

      const third = await journal.advance({ name: "main", scope: "shared", expectedHead: head2, expectedSequence: 1, newHead: head3 });
      expect(third).toMatchObject({ ok: true, applied: true });
      if (third.ok) {
        expect(third.entry).toMatchObject({ head: head3, sequence: 2 });
      }
    });
  });

  it("rejects a stale head (lost-update protection)", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      const head1 = address({ v: 1 });
      const head2 = address({ v: 2 });
      await journal.advance({ name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: head1 });

      // A concurrent writer already moved the head to head2; a stale write must fail.
      await journal.advance({ name: "main", scope: "shared", expectedHead: head1, expectedSequence: 0, newHead: head2 });
      const stale = await journal.advance({ name: "main", scope: "shared", expectedHead: head1, expectedSequence: 0, newHead: address({ v: "other" }) });
      expect(stale).toMatchObject({ ok: false, reason: "stale" });
      expect(journal.read("main")?.head).toBe(head2);
    });
  });

  it("rejects a conflicting sequence", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      const head1 = address({ v: 1 });
      await journal.advance({ name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: head1 });
      const conflict = await journal.advance({ name: "main", scope: "shared", expectedHead: head1, expectedSequence: 5, newHead: address({ v: 9 }) });
      expect(conflict).toMatchObject({ ok: false, reason: "conflict" });
    });
  });

  it("rejects a genesis advance with a non-zero expectedSequence", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      const outcome = await journal.advance({
        name: "new-line",
        scope: "local",
        expectedHead: genesisHead,
        expectedSequence: 3,
        newHead: address({ v: 1 })
      });
      expect(outcome).toMatchObject({ ok: false, reason: "missing_line" });
      expect(journal.read("new-line")).toBeUndefined();
    });
  });

  it("is idempotent: a retried request returns the original result without double-advancing", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      const head1 = address({ v: 1 });
      const key = "request-abc-123";

      const first = await journal.advance({
        name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: head1, idempotencyKey: key
      });
      expect(first).toMatchObject({ ok: true, applied: true });

      // Retry with the same key but a different (would-be) newHead: must not apply.
      const retry = await journal.advance({
        name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: address({ v: "DIFFERENT" }), idempotencyKey: key
      });
      expect(retry).toMatchObject({ ok: true, applied: false });
      if (retry.ok) {
        expect(retry.entry).toMatchObject({ head: head1, sequence: 0 });
      }
      expect(journal.read("main")?.head).toBe(head1);
    });
  });

  it("serializes concurrent advances without lost updates", async () => {
    await withTemporaryRoot(async (root) => {
      const journal = new FileLineJournal(root);
      await journal.advance({ name: "main", scope: "shared", expectedHead: genesisHead, expectedSequence: 0, newHead: address({ v: 0 }) });

      // Fire many advances concurrently from the same genesis snapshot; only one
      // may win because the others see a stale head/sequence.
      const attempts = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          journal.advance({
            name: "main",
            scope: "shared",
            expectedHead: address({ v: 0 }),
            expectedSequence: 0,
            newHead: address({ v: i + 1 })
          })
        )
      );
      const applied = attempts.filter((a) => a.ok && a.applied).length;
      expect(applied).toBe(1);
      // The journal is still coherent: exactly one advance committed.
      expect(journal.read("main")?.sequence).toBe(1);
    });
  });

  it("recover() removes orphaned temp files", () => {
    withTemporaryRoot((root) => {
      const journal = new FileLineJournal(root);
      writeFileSync(join(root, "lines", ".orphan.1.tmp"), "{}", "utf8");
      writeFileSync(join(root, "lines", ".orphan.2.tmp"), "{}", "utf8");
      journal.recover();
      const temps = readdirSync(join(root, "lines")).filter((f) => f.endsWith(".tmp"));
      expect(temps).toHaveLength(0);
    });
  });
});
