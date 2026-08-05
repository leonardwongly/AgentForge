/**
 * @agentforge/loom-core — canonical type surface.
 *
 * This is the deterministic, dependency-free core of Loom (see
 * docs/loom/loom-detailed-design.md). It models the object graph (Cell/State),
 * the change primitive (Transform + typed Ops), stable identity (NodeIdent),
 * the merge/reapply engine, and capability authorization (Grant).
 *
 * v1 simplifications (faithful to the design, smaller in scope):
 * - Content is inlined as UTF-8 `text` on a Cell (the design's content-addressed
 *   blob store is deferred); the `bytes` facet stores opaque text as well.
 * - A State is a flat path -> Cell map (the design's nested Weave is an encoding
 *   optimization with identical semantics for the algebra).
 * - Signatures/provenance envelopes are out of this pure slice (they require
 *   crypto/DSSE and are tracked as remaining work).
 */

/** Content address of a canonically-encoded object. Branded to prevent misuse. */
export type Cid = string & { readonly __brand: "loom.Cid" };

/** Stable identity of a Cell that survives moves/renames. Branded. */
export type NodeIdent = string & { readonly __brand: "loom.NodeIdent" };

/** Decentralised identifier for an Actor (human | agent | automation). */
export type Did = string & { readonly __brand: "loom.Did" };

/** The representation lane of a Cell. TEXT is authoritative (design §3.3). */
export type CellFacet = "text" | "bytes";

/** The typed unit of state. */
export interface Cell {
  readonly facet: CellFacet;
  readonly ident: NodeIdent;
  /** Inlined UTF-8 content (v1). The content address is derived, see addressing.ts. */
  readonly text: string;
  /** POSIX mode bits, when meaningful. */
  readonly mode?: number | undefined;
}

/** A whole-tree snapshot: path -> Cell. The identity index is derivable. */
export interface State {
  readonly kind: "state";
  /** Ordered by path at addressing time for determinism. */
  readonly cells: Readonly<Record<string, Cell>>;
}

/** Selects a Cell either by stable identity or by current path. */
export type NodeSelector = { readonly nid: NodeIdent } | { readonly path: string };

/** The closed, versioned effect vocabulary (design §3.2). */
export type Effect =
  | "edits_source"
  | "deletes_source"
  | "moves_cell"
  | "adds_dependency"
  | "bumps_dependency_major"
  | "bumps_dependency_minor"
  | "removes_dependency"
  | "adds_migration"
  | "deletes_migration"
  | "deletes_test"
  | "skips_test"
  | "changes_ci"
  | "touches_sensitive_path"
  | "adds_secret_like_value"
  | "adds_generated_artifact";

/** STOP operations (v1 subset; design §3.1). */
export type Op =
  | {
      readonly op: "put_cell";
      readonly at: string;
      readonly ident: NodeIdent;
      readonly facet: CellFacet;
      readonly text: string;
      readonly mode?: number | undefined;
    }
  | { readonly op: "delete_cell"; readonly sel: NodeSelector }
  | { readonly op: "move_cell"; readonly sel: NodeSelector; readonly to: string }
  | {
      readonly op: "patch_text";
      readonly sel: NodeSelector;
      readonly range: readonly [number, number];
      readonly text: string;
    };

/** First-class, machine-readable goal + acceptance criteria. */
export interface Intent {
  readonly kind: "intent";
  readonly title: string;
  readonly criteria: ReadonlyArray<
    | { readonly kind: "attestation"; readonly statement: string }
    | { readonly kind: "check"; readonly statement: string; readonly check: Cid }
  >;
  readonly author: Did;
}

export type DeterminismClass = "pinned" | "environment-sensitive" | "nondeterministic";

/** Pinned tool identities that make a recipe reproducible. */
export interface ToolchainLock {
  readonly engineDigest: string;
  readonly runtimeDigest: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export type EngineId = "regex-replace" | "dep-bump";

/** Machine-checkable post-condition on a reapply candidate (design §3.3). */
export type Invariant =
  | { readonly kind: "max_cells_written"; readonly limit: number }
  | { readonly kind: "no_new_effect"; readonly not: ReadonlyArray<Effect> }
  | { readonly kind: "path_unchanged"; readonly path: string };

/** The executable transformation that makes a Transform reapply-eligible. */
export interface Recipe {
  readonly engine: EngineId;
  readonly determinismClass: DeterminismClass;
  readonly toolchain: ToolchainLock;
  /** Engine-specific rule payload (e.g. {find, replace} for regex-replace). */
  readonly rule: Readonly<Record<string, unknown>>;
  readonly inputSelector: ReadonlyArray<NodeSelector>;
  readonly writeScope: ReadonlyArray<NodeSelector>;
  readonly invariants?: ReadonlyArray<Invariant> | undefined;
  readonly expectedResultDigest?: string | undefined;
}

/** THE unit of change. */
export interface Transform {
  readonly kind: "transform";
  readonly parents: ReadonlyArray<Cid>;
  readonly baseState: Cid;
  readonly resultState: Cid;
  readonly ops: ReadonlyArray<Op>;
  readonly effects: ReadonlyArray<Effect>;
  readonly intent: Cid;
  readonly author: Did;
  readonly recipe?: Recipe | undefined;
  readonly authoredAt: string;
}

export type LineScope = "local" | "shared";

export interface Line {
  readonly kind: "line";
  readonly name: string;
  readonly scope: LineScope;
  readonly head: Cid;
  readonly controller?: Did | undefined;
}

// ---- Algebra results -------------------------------------------------------

export type ApplyError =
  | { readonly code: "precondition"; readonly detail: string }
  | { readonly code: "scope_violation"; readonly detail: string };

export type ApplyResult =
  { readonly ok: true; readonly state: State } | { readonly ok: false; readonly error: ApplyError };

export interface EffectCheck {
  readonly ok: boolean;
  /** Effects implied by ops but not declared (under-declaration is rejected). */
  readonly missing: ReadonlyArray<Effect>;
  /** Effects declared but not implied (allowed, but surfaced). */
  readonly extra: ReadonlyArray<Effect>;
}

// ---- Merge / reapply -------------------------------------------------------

export type ConflictClass = "independent" | "commuting" | "recomputable" | "conflict";

export interface Conflict {
  readonly nid: NodeIdent;
  readonly path: string;
  readonly kind:
    "content" | "binary" | "delete/edit" | "move/move" | "path-collision" | "recompute-divergence";
  /** The second identity when distinct Cells resolve to the same path. */
  readonly otherNid?: NodeIdent | undefined;
  readonly base?: string | undefined;
  readonly ours?: string | undefined;
  readonly theirs?: string | undefined;
  readonly basePath?: string | undefined;
  readonly oursPath?: string | undefined;
  readonly theirsPath?: string | undefined;
  readonly baseFacet?: CellFacet | undefined;
  readonly oursFacet?: CellFacet | undefined;
  readonly theirsFacet?: CellFacet | undefined;
  readonly baseMode?: number | undefined;
  readonly oursMode?: number | undefined;
  readonly theirsMode?: number | undefined;
  readonly textConflict?: string | undefined;
  readonly suggestedResolution?: string | undefined;
}

export interface MergeResult {
  readonly candidate: State;
  readonly conflicts: ReadonlyArray<Conflict>;
}

export type ReapplyOutcome =
  | {
      readonly kind: "CleanReapply";
      readonly resultState: State;
      readonly recomputed: true;
      readonly changedResult: boolean;
    }
  | {
      readonly kind: "Divergence";
      readonly expected: Cid;
      readonly actual: Cid;
      readonly report: string;
    }
  | {
      readonly kind: "HardFailure";
      readonly reason:
        | "no-recipe"
        | "nondeterministic"
        | "toolchain_mismatch"
        | "precondition"
        | "engine_error"
        | "nondeterministic_engine";
      readonly detail: string;
    };

// ---- Capabilities (Grant) --------------------------------------------------

export interface EffectBounds {
  readonly maxCellsTouched: number;
  readonly allowDelete: boolean;
  readonly allowSensitive: boolean;
  readonly allowedEffectKinds: ReadonlyArray<Effect>;
}

export type Caveat =
  | { readonly kind: "not_after"; readonly iso: string }
  | { readonly kind: "not_before"; readonly iso: string };

export interface Grant {
  readonly issuer: Did;
  readonly audience: Did;
  readonly transformTypes: ReadonlyArray<Op["op"] | "*">;
  /** Path globs the audience may touch (minimatch-style; "**" = all). */
  readonly cellSelectors: ReadonlyArray<string>;
  readonly effectBounds: EffectBounds;
  readonly caveats?: ReadonlyArray<Caveat> | undefined;
  readonly expiry?: string | undefined;
}

export type AuthzDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string };
