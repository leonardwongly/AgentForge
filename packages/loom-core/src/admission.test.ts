import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { address } from "./addressing.js";
import { FileLineJournal } from "./store.js";
import { ProposalStore } from "./admission.js";
import type { Cid } from "./types.js";

const GENESIS = address({ kind: "line", name: "x", scope: "shared", head: "x" as Cid });

function withStore(
  run: (root: string, journal: FileLineJournal, store: ProposalStore) => void | Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "loom-admission-"));
  const journal = new FileLineJournal(root);
  const store = new ProposalStore(root, journal);
  return Promise.resolve(run(root, journal, store)).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

describe("Proposal/admission state machine", () => {
  it("moves draft -> proposed -> admitted with approvals and evidence", async () => {
    await withStore(async (_root, journal, store) => {
      await journal.advance({
        name: "billing",
        scope: "shared",
        expectedHead: GENESIS,
        expectedSequence: 0,
        newHead: GENESIS
      });
      const proposal = store.create({
        title: "billing change",
        updates: [
          {
            line: "billing",
            expectedHead: GENESIS,
            expectedSequence: 0,
            newHead: address({ v: 1 })
          }
        ],
        requiredReviewers: ["did:loom:reviewer"],
        requiredEvidence: ["rollback_plan"]
      });
      expect(proposal.state).toBe("draft");

      store.submit(proposal.id);
      expect(store.get(proposal.id)?.state).toBe("proposed");

      // Admission is blocked until approvals + evidence are present.
      const blocked = await store.admit(proposal.id);
      expect(blocked.ok).toBe(false);
      expect(blocked.ok === false && blocked.reason).toMatch(/missing/);

      store.approve(proposal.id, "did:loom:reviewer");
      store.provideEvidence(proposal.id, "rollback_plan");
      const admitted = await store.admit(proposal.id);
      expect(admitted.ok).toBe(true);
      expect(store.get(proposal.id)?.state).toBe("admitted");
      // The Line actually advanced.
      expect(journal.read("billing")?.head).toBe(address({ v: 1 }));
    });
  });

  it("cannot admit a proposal that is not proposed", async () => {
    await withStore(async (_root, _journal, store) => {
      const proposal = store.create({ title: "x", updates: [] });
      const result = await store.admit(proposal.id);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/not proposed/);
    });
  });

  it("rejects a proposal and cannot later admit it", async () => {
    await withStore(async (_root, _journal, store) => {
      const proposal = store.create({ title: "x", updates: [] });
      store.submit(proposal.id);
      store.reject(proposal.id);
      expect(store.get(proposal.id)?.state).toBe("rejected");
      const result = await store.admit(proposal.id);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/rejected/);
    });
  });

  it("rejects invalid state transitions", async () => {
    await withStore(async (_root, _journal, store) => {
      const proposal = store.create({ title: "x", updates: [] });
      // draft -> rejected is not a valid transition.
      expect(() => store.reject(proposal.id)).toThrow(/invalid proposal transition/);
    });
  });

  it("fails admission when the cross-Line commit conflicts (nothing advances)", async () => {
    await withStore(async (root, journal, store) => {
      // Advance the line first so the proposal's expected head is stale.
      await journal.advance({
        name: "billing",
        scope: "shared",
        expectedHead: GENESIS,
        expectedSequence: 0,
        newHead: address({ v: "prior" })
      });
      const proposal = store.create({
        title: "stale",
        updates: [
          {
            line: "billing",
            expectedHead: GENESIS,
            expectedSequence: 0,
            newHead: address({ v: 2 })
          }
        ],
        requiredReviewers: ["r"],
        requiredEvidence: []
      });
      store.submit(proposal.id);
      store.approve(proposal.id, "r");
      const result = await store.admit(proposal.id);
      expect(result.ok).toBe(false);
      expect(store.get(proposal.id)?.state).toBe("proposed");
      expect(journal.read("billing")?.head).toBe(address({ v: "prior" }));
    });
  });

  it("is idempotent for approvals and evidence", async () => {
    await withStore(async (_root, _journal, store) => {
      const proposal = store.create({
        title: "x",
        updates: [],
        requiredReviewers: ["r"],
        requiredEvidence: ["e"]
      });
      store.submit(proposal.id);
      store.approve(proposal.id, "r");
      store.approve(proposal.id, "r");
      store.provideEvidence(proposal.id, "e");
      store.provideEvidence(proposal.id, "e");
      expect(store.get(proposal.id)?.approvals).toEqual(["r"]);
      expect(store.get(proposal.id)?.providedEvidence).toEqual(["e"]);
    });
  });
});
