/**
 * @agentforge/loom-core — Proposal/admission state machine (Phase 1, spec §13).
 *
 * A Proposal moves through a validated state machine: `draft` -> `proposed` ->
 * `admitted` | `rejected`. Admission is gated on the proposal being proposed,
 * all required reviewer approvals and evidence being present, and the
 * cross-Line commit succeeding atomically. A proposal can be admitted at most
 * once; a rejected proposal cannot be admitted.
 */

import { randomUUID } from "node:crypto";

import { commitProposal, type ProposalUpdate } from "./proposal.js";
import type { FileLineJournal } from "./store.js";

export type ProposalState = "draft" | "proposed" | "admitted" | "rejected";

export interface Proposal {
  readonly id: string;
  /** Author identity, when created through an authenticated client. */
  readonly author?: string | undefined;
  state: ProposalState;
  readonly title: string;
  readonly updates: readonly ProposalUpdate[];
  readonly requiredReviewers: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly approvals: string[];
  readonly providedEvidence: string[];
}

export interface CreateProposalInput {
  readonly title: string;
  readonly updates: readonly ProposalUpdate[];
  readonly author?: string | undefined;
  readonly requiredReviewers?: readonly string[] | undefined;
  readonly requiredEvidence?: readonly string[] | undefined;
}

export type AdmissionResult =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly reason: string };

/** Valid state transitions. */
const TRANSITIONS: Record<ProposalState, ReadonlySet<ProposalState>> = {
  draft: new Set(["proposed"]),
  proposed: new Set(["admitted", "rejected"]),
  admitted: new Set(),
  rejected: new Set()
};

export class ProposalStore {
  private readonly proposals = new Map<string, Proposal>();

  constructor(
    private readonly root: string,
    private readonly journal: FileLineJournal
  ) {}

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  create(input: CreateProposalInput): Proposal {
    // A proposal without an explicit reviewer requirement must not become a
    // self-approving admission primitive. Keep a conservative maintainer gate
    // even when an untrusted caller supplies `undefined` or an empty list.
    const requiredReviewers = [...(input.requiredReviewers ?? [])];
    if (requiredReviewers.length === 0) {
      requiredReviewers.push("maintainer");
    }
    const proposal: Proposal = {
      id: randomUUID(),
      ...(input.author !== undefined ? { author: input.author } : {}),
      state: "draft",
      title: input.title,
      updates: input.updates,
      requiredReviewers,
      requiredEvidence: input.requiredEvidence ?? [],
      approvals: [],
      providedEvidence: []
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /** Approve as a reviewer (idempotent). */
  approve(id: string, reviewer: string, actor?: string): Proposal | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.state !== "proposed") {
      return proposal;
    }
    if (
      !proposal.requiredReviewers.includes(reviewer) ||
      (actor !== undefined && actor === proposal.author)
    ) {
      return proposal;
    }
    if (!proposal.approvals.includes(reviewer)) {
      proposal.approvals.push(reviewer);
    }
    return proposal;
  }

  /** Provide an evidence kind (idempotent). */
  provideEvidence(id: string, kind: string): Proposal | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.state !== "proposed") {
      return proposal;
    }
    if (!proposal.requiredEvidence.includes(kind)) {
      return proposal;
    }
    if (!proposal.providedEvidence.includes(kind)) {
      proposal.providedEvidence.push(kind);
    }
    return proposal;
  }

  /** draft -> proposed. */
  submit(id: string): Proposal | undefined {
    return this.transition(id, "proposed");
  }

  /** proposed -> rejected. */
  reject(id: string): Proposal | undefined {
    return this.transition(id, "rejected");
  }

  /** proposed -> admitted, gated on approvals, evidence, and atomic commit. */
  async admit(id: string): Promise<AdmissionResult> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      return { ok: false, reason: "proposal not found" };
    }
    if (proposal.state !== "proposed") {
      return { ok: false, reason: `proposal is ${proposal.state}, not proposed` };
    }
    const missingReviewers = proposal.requiredReviewers.filter(
      (reviewer) => !proposal.approvals.includes(reviewer)
    );
    if (missingReviewers.length > 0) {
      return { ok: false, reason: `missing reviewer approvals: ${missingReviewers.join(", ")}` };
    }
    const missingEvidence = proposal.requiredEvidence.filter(
      (kind) => !proposal.providedEvidence.includes(kind)
    );
    if (missingEvidence.length > 0) {
      return { ok: false, reason: `missing evidence: ${missingEvidence.join(", ")}` };
    }
    const commit = await commitProposal(this.root, this.journal, proposal.updates);
    if (!commit.ok) {
      return { ok: false, reason: commit.reason ?? "cross-Line commit failed" };
    }
    proposal.state = "admitted";
    return { ok: true, proposal };
  }

  private transition(id: string, next: ProposalState): Proposal | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      return undefined;
    }
    if (!TRANSITIONS[proposal.state].has(next)) {
      throw new Error(`loom: invalid proposal transition ${proposal.state} -> ${next}`);
    }
    proposal.state = next;
    return proposal;
  }
}
