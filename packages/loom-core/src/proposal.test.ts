import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { address } from "./addressing.js";
import { FileLineJournal } from "./store.js";
import {
  commitProposal,
  prepareProposal,
  resolveShard,
  validateShards,
  type LineShard,
  type ProposalUpdate
} from "./proposal.js";
import type { Cid } from "./types.js";

const GENESIS = address({ kind: "line", name: "x", scope: "shared", head: "x" as Cid });

function withJournal(run: (root: string, journal: FileLineJournal) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "loom-proposal-"));
  return Promise.resolve(run(root, new FileLineJournal(root))).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

function update(line: string, expectedSequence: number, newHead: Cid): ProposalUpdate {
  return { line, expectedHead: GENESIS, expectedSequence, newHead };
}

describe("sharding model", () => {
  const shards: LineShard[] = [
    { line: "billing", scope: "shared", pathPrefix: "src/billing/" },
    { line: "payments", scope: "shared", pathPrefix: "src/payments/" }
  ];

  it("validates disjoint shards and rejects overlaps/empty prefixes", () => {
    expect(validateShards(shards)).toBeUndefined();
    expect(validateShards([...shards, { line: "x", scope: "shared", pathPrefix: "src/billing/" }])).toMatch(
      /duplicate path prefix/
    );
    expect(validateShards([{ line: "x", scope: "shared", pathPrefix: "" }])).toMatch(/empty path prefix/);
  });

  it("resolves a path to its owning shard", () => {
    expect(resolveShard(shards, "src/billing/checkout.ts")?.line).toBe("billing");
    expect(resolveShard(shards, "src/payments/ledger.ts")?.line).toBe("payments");
    expect(resolveShard(shards, "src/other/x.ts")).toBeUndefined();
  });
});

describe("cross-Line atomic proposal", () => {
  it("prepares successfully when all CAS conditions hold", async () => {
    await withJournal(async (_root, journal) => {
      const updates = [update("a", 0, address({ a: 1 })), update("b", 0, address({ b: 1 }))];
      expect(prepareProposal(journal, updates)).toBeUndefined();
    });
  });

  it("prepare reports a stale line and commits nothing", async () => {
    await withJournal(async (_root, journal) => {
      await journal.advance({ name: "a", scope: "shared", expectedHead: GENESIS, expectedSequence: 0, newHead: address({ a: 1 }) });
      const updates = [update("a", 0, address({ a: 2 })), update("b", 0, address({ b: 1 }))];
      expect(prepareProposal(journal, updates)).toMatch(/head moved/);
    });
  });

  it("commits all lines atomically", async () => {
    await withJournal(async (root, journal) => {
      const headA = address({ a: 1 });
      const headB = address({ b: 1 });
      const result = await commitProposal(root, journal, [update("a", 0, headA), update("b", 0, headB)]);
      expect(result.ok).toBe(true);
      expect(result.committed).toHaveLength(2);
      expect(journal.read("a")?.head).toBe(headA);
      expect(journal.read("b")?.head).toBe(headB);
    });
  });

  it("rejects atomically when one line conflicts (nothing advances)", async () => {
    await withJournal(async (root, journal) => {
      // Advance line "a" so the proposal's expected head for "a" is stale.
      await journal.advance({ name: "a", scope: "shared", expectedHead: GENESIS, expectedSequence: 0, newHead: address({ a: 1 }) });
      const result = await commitProposal(root, journal, [
        update("a", 0, address({ a: 2 })),
        update("b", 0, address({ b: 1 }))
      ]);
      expect(result.ok).toBe(false);
      expect(result.committed).toHaveLength(0);
      // Line "b" must NOT have advanced.
      expect(journal.read("b")).toBeUndefined();
    });
  });

  it("is idempotent under a retried proposal (same new heads)", async () => {
    await withJournal(async (root, journal) => {
      const headA = address({ a: 1 });
      const headB = address({ b: 1 });
      const first = await commitProposal(root, journal, [update("a", 0, headA), update("b", 0, headB)]);
      expect(first.ok).toBe(true);
      // A retry with the same expected heads fails closed (already advanced).
      const retry = await commitProposal(root, journal, [update("a", 0, headA), update("b", 0, headB)]);
      expect(retry.ok).toBe(false);
      expect(journal.read("a")?.head).toBe(headA);
      expect(journal.read("b")?.head).toBe(headB);
    });
  });
});
