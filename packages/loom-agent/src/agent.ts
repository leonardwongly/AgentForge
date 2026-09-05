/**
 * @agentforge/loom-agent — native end-user and agent client SDK (Phase 3,
 * spec §10.4/§13).
 *
 * The {@link AgentClient} is the programmatic counterpart to the CLI: it ties the
 * loom-core primitives together into a single delegated-change workflow so an
 * end-user application or autonomous agent can:
 *
 *  1. create a bounded, delegated session (spec §10.4);
 *  2. capture a change journal from a working copy and derive the native
 *     effect vocabulary (spec §10.2/§13.2);
 *  3. build and validate a Recipe (spec §7.7);
 *  4. derive the native review requirements (required evidence + reviewers)
 *     that the change's effects imply (spec §13);
 *  5. track the work in a dependency-ordered work graph (spec §10.4); and
 *  6. submit and admit a cross-Line proposal (spec §13.3).
 *
 * Every write is routed through the session so the agent can only touch paths
 * inside its delegated write scope and within its resource budget. The client
 * is a thin, dependency-injected orchestrator over loom-core; it holds no
 * production state of its own.
 */

import { join } from "node:path";

import {
  createRecipe,
  diffWorkingCopy,
  effectsFromChangeJournal,
  FileLineJournal,
  ProposalStore,
  reviewRequirementsForEffects,
  SessionStore,
  WorkGraph,
  type AgentSession,
  type ChangeJournal,
  type Did,
  type Effect,
  type Proposal,
  type ProposalUpdate,
  type Recipe,
  type ReviewRequirement,
  type State
} from "@agentforge/loom-core";

/** Configuration for an {@link AgentClient}. */
export interface AgentClientOptions {
  /** Repository root; the client stores its proposal journal under `.loom`. */
  readonly root: string;
  /** The agent's own `did:loom` identity. */
  readonly agentDid: Did;
  /** The Grant (authority) the agent is acting under. */
  readonly grantId: string;
  /** Path prefixes the agent is allowed to write. */
  readonly writeScope: readonly string[];
  /** Maximum number of writes the agent may record in a session. */
  readonly maxWrites?: number;
}

/** A change captured from a working copy, with its derived native facts. */
export interface ChangeReport {
  readonly session: AgentSession;
  readonly journal: ChangeJournal;
  /** The native effect vocabulary implied by the change journal. */
  readonly effects: readonly Effect[];
  /** Review requirements (evidence + reviewers) implied by the effects. */
  readonly reviewRequirements: readonly ReviewRequirement[];
  /** Number of writes recorded against the session. */
  readonly writes: number;
  /** True if every changed path fell within the session's write scope. */
  readonly withinScope: boolean;
}

/** Input for {@link AgentClient.captureChange}. */
export interface CaptureChangeInput {
  /** The working copy directory to diff against the base State. */
  readonly workingDir: string;
  /** The base State the working copy is compared to. */
  readonly baseState: State;
  /** Paths to exclude from the diff (e.g. the `.loom` store itself). */
  readonly exclude?: ReadonlySet<string>;
}

/** Input for {@link AgentClient.buildRecipe}. */
export interface BuildRecipeInput {
  readonly engine: "regex-replace" | "dep-bump";
  readonly rule: Readonly<Record<string, unknown>>;
  readonly inputSelector: ReadonlyArray<{ readonly path: string } | { readonly nid: string }>;
  readonly writeScope: ReadonlyArray<{ readonly path: string } | { readonly nid: string }>;
  readonly invariants?: ReadonlyArray<unknown>;
  readonly expectedResultDigest?: string;
}

/** Input for {@link AgentClient.trackWork}. */
export interface TrackWorkInput {
  readonly sessionId: string;
  readonly title?: string;
  readonly transformCid?: string;
  /** IDs of work nodes this node depends on (ordered before it). */
  readonly dependsOn?: readonly string[];
}

/** Input for {@link AgentClient.submitProposal}. */
export interface SubmitProposalInput {
  readonly title: string;
  readonly updates: readonly ProposalUpdate[];
  readonly requiredReviewers?: readonly string[];
  readonly requiredEvidence?: readonly string[];
}

/**
 * Programmatic agent client. Each client owns its in-memory session, work
 * graph, and proposal stores; the proposal store persists to the repository's
 * `.loom` journal so admission is crash-safe and cross-Line atomic.
 */
export class AgentClient {
  private readonly sessions: SessionStore;
  private readonly workGraph: WorkGraph;
  private readonly proposals: ProposalStore;

  constructor(private readonly options: AgentClientOptions) {
    this.sessions = new SessionStore();
    this.workGraph = new WorkGraph();
    this.proposals = new ProposalStore(options.root, new FileLineJournal(join(options.root, ".loom")));
  }

  /** Create a new delegated session for this agent. */
  createSession(): AgentSession {
    return this.sessions.create({
      agentDid: this.options.agentDid,
      grantId: this.options.grantId,
      writeScope: this.options.writeScope,
      maxWrites: this.options.maxWrites
    });
  }

  /**
   * Capture a change from a working copy: diff it against the base State,
   * derive the native effects and review requirements, and record every
   * changed path against the session's write budget. The report flags
   * `withinScope: false` if any path fell outside the session's write scope.
   */
  captureChange(session: AgentSession, input: CaptureChangeInput): ChangeReport {
    // Administrative trees are never delegated content. In particular, do not
    // let a working copy's `.git` hooks/objects become proposed Loom writes
    // when callers omit an exclude set.
    const exclude = new Set(input.exclude ?? []);
    exclude.add(".git");
    const journal = diffWorkingCopy(input.workingDir, input.baseState, exclude);
    const effects = effectsFromChangeJournal(journal);
    const reviewRequirements = reviewRequirementsForEffects(effects);

    let writes = 0;
    let withinScope = true;
    const paths = [...journal.added, ...journal.modified, ...journal.removed];
    for (const path of paths) {
      if (this.sessions.recordWrite(session, path)) {
        writes += 1;
      } else {
        withinScope = false;
      }
    }
    return { session, journal, effects, reviewRequirements, writes, withinScope };
  }

  /**
   * Build and validate a Recipe. Throws on an invalid rule shape, an
   * over-budget recipe, or an invalid invariant.
   */
  buildRecipe(input: BuildRecipeInput): Recipe {
    return createRecipe({
      engine: input.engine,
      determinismClass: "pinned",
      toolchain: { engineDigest: "loom-agent-v1", runtimeDigest: "node" },
      rule: input.rule,
      inputSelector: input.inputSelector as never,
      writeScope: input.writeScope as never,
      ...(input.invariants ? { invariants: input.invariants as never } : {}),
      ...(input.expectedResultDigest !== undefined
        ? { expectedResultDigest: input.expectedResultDigest }
        : {})
    });
  }

  /** Add a work node (and optional dependency edges) to the work graph. */
  trackWork(input: TrackWorkInput): { readonly nodeId: string; readonly order: readonly string[] } {
    const node = this.workGraph.addNode({
      agentDid: this.options.agentDid,
      sessionId: input.sessionId,
      transformCid: input.transformCid,
      title: input.title
    });
    for (const dependency of input.dependsOn ?? []) {
      this.workGraph.addEdge(dependency, node.id);
    }
    const order = this.workGraph.topologicalOrder();
    if (order === undefined) {
      throw new Error("loom-agent: work graph contains a cycle");
    }
    return { nodeId: node.id, order: order.map((n) => n.id) };
  }

  /** Create and submit a proposal (draft -> proposed). */
  submitProposal(input: SubmitProposalInput): Proposal {
    const proposal = this.proposals.create({
      title: input.title,
      updates: input.updates,
      author: String(this.options.agentDid),
      requiredReviewers: input.requiredReviewers,
      requiredEvidence: input.requiredEvidence
    });
    const submitted = this.proposals.submit(proposal.id);
    if (submitted === undefined) {
      throw new Error("loom-agent: proposal could not be submitted");
    }
    return submitted;
  }

  /** Approve a proposal as a reviewer (idempotent). */
  approveProposal(id: string, reviewer: string): Proposal | undefined {
    // The submitting agent cannot satisfy its own review gate merely by
    // echoing its caller-controlled DID as the reviewer identity.
    if (reviewer === String(this.options.agentDid)) {
      return this.proposals.get(id);
    }
    return this.proposals.approve(id, reviewer);
  }

  /** Provide an evidence kind to a proposal (idempotent). */
  provideEvidence(id: string, kind: string): Proposal | undefined {
    return this.proposals.provideEvidence(id, kind);
  }

  /** Admit a proposal (gated on approvals, evidence, and atomic commit). */
  admitProposal(id: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    return this.proposals.admit(id);
  }

  /** Look up a proposal by id. */
  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }
}
