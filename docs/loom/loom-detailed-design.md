# Loom — Native Agentic Version Control: Detailed Design

> Status: design proposal (v3-detail). Not implemented. This document specifies the
> end-goal reimagining of AgentForge into **Loom**, a native agentic version-control
> substrate. The strategy and the honest verdict are settled (see Preamble); this
> document is the implementation-grade depth: object schemas, the Transform algebra,
> `reapply` semantics, the admission pipeline, wire formats, the detector rebuild,
> the schema migration, per-phase engineering criteria, and worked examples.

## Preamble (read this first — it is deliberately un-hyped)

Loom is a **git-CLASS** model — content-addressed objects, a lineage DAG, LCA/merge-base
base selection, and text 3-way merge on the blocking path — with a **novel identity,
trust root, provenance model, and governance gate**. It does **not** eliminate the git
_model_; it eliminates git-the-implementation and GitHub-the-host as dependencies, and
inverts the coupling so intent+provenance become first-class.

Four honesty constraints hold throughout and are never re-argued:

1. **Attested, not proven.** Provenance records _who/which model/which prompt/tools/context_
   produced a change and binds it cryptographically. It does **not** prove the code is
   correct, secure, or that the claimed model actually produced it. `attested` confidence
   is non-blocking by construction (reuses `BLOCKABLE_CONFIDENCES = {verified, observed}`).
2. **Text lane is authoritative.** The TEXT representation of a change is mandatory and
   decides all blocking facts. The SEMANTIC (AST/op) lane is additive enrichment and covers
   ~0 languages at v1. Detectors are **rebuilt** to parse a Fabric-computed diff view.
3. **`reapply` only wins for mechanical, deterministic transformations** (codemods,
   migrations, dependency/security remediation, generated code). For creative logic it
   degrades to a recorded diff.
4. **P2 (a governance + provenance LAYER on git) is the realistic product.** Owning the
   substrate (P3+) is a **kill-gated research track**, not a promised destination.

## Table of contents

1. Scope & non-negotiables
2. Object & change model (AFOM)
3. Transform algebra & `reapply` (STOP)
4. Governance write-path (RATP) & re-homing
5. Detector rebuild
6. Persistence schema migration
7. Distribution (RSP)
8. Ledger, witnesses & trust
9. Identity, Grants & provenance (PXP / PAL)
10. Module layout
11. Phased roadmap & kill-gates
12. Test & conformance strategy
13. Repository/history migration
14. Worked end-to-end scenario
15. Risk register
16. Open questions
17. Gap register (today → end goal)
18. Independent stress-test & scope revision

---

## 1. Scope & non-negotiables

**In scope:** the object model, change model, governance write-path, distribution, trust
anchor, identity, provenance, and the phased plan to get there from today's GitHub-first
AgentForge (`v1.1.0`).

**Reused verbatim from AgentForge** (`@agentforge/core`, `@agentforge/policy`,
`@agentforge/evidence`, `@agentforge/records`, `@agentforge/security`, and the _routing_
half of `@agentforge/reviewers`): `VerifiedFact`, `PolicyResult`, `EvidenceRequirement`,
`ReviewerRequirement`, `ChangeControlRecord`, the `confidenceCanBlock` rule, the policy
evaluator, and exports/compliance packaging. These are re-homed onto Transforms (§4).

**Discarded:** `@agentforge/github` in its entirety, the GitHub `ScmProvider` impl, the
CODEOWNERS parser + GitHub team/review validators, check-run publication, webhook
delivery/replay, and the `PullRequest`/`headSha`/`baseBranch` vocabulary (§6).

**Non-negotiables:** (N1) object identity, addressing, and the wire protocol are Loom's,
not git's or GitHub's; (N2) integrity is client-verifiable against a witnessed Ledger, not
by trusting a host (degrades honestly in single-tenant, §8); (N3) every Transform carries a
first-class provenance attestation (attested, not proven); (N4) governance is the
shared-history admission protocol, not a bolt-on check.

---

## 2. Object & change model (AFOM)

AFOM (AgentForge Object Model) is the content-addressed store. Encoding is **IPLD
dag-cbor** (canonical, deterministic); addresses are **CIDv1 + multihash**. The hash is
`sha2-256` at v1 with documented **multihash agility** toward BLAKE3 (the swap is gated to
P4 behind a dual-hash transition window; see §16 open question 5 and risk #9). All hashing
goes through a single `TreeHasher` abstraction so the function can be rotated.

### 2.1 Addressing

```
Address (CID) = CIDv1(codec = dag-cbor (0x71), multihash = sha2-256(canonical_dagcbor(object)))
Text form: "bafy…" (base32). In-code type: `type Cid = string & { __brand: "cid" }`.
```

`Fabric.put(object) -> Cid` computes the canonical encoding and hash; `Fabric.get(cid)`
returns bytes; `Fabric.has(cid) -> bool`. `verifyAddress(cid, bytes)` re-hashes and rejects
on mismatch (a single bit flip fails). Objects are immutable and de-duplicated by CID.

### 2.2 Object kinds (TS surface — canonical source of truth)

```ts
// A raw byte object (leaf). Large blobs are content-defined-chunked (FastCDC) into
// a Blob tree; small blobs stored inline.
interface Blob {
  kind: "blob";
  size: number;
  chunks?: Cid[];
  inline?: Uint8Array;
}

// A Cell is the typed unit of STATE. Every Cell has a *stable identity* (NodeIdent)
// that survives moves/renames, plus a content CID that changes when content changes.
type CellFacet = "bytes" | "text" | "structured" | "ast";
interface Cell {
  kind: "cell";
  facet: CellFacet;
  ident: NodeIdent; // stable identity (see 2.3)
  content: Cid; // -> Blob (bytes/text) or a structured/ast node object
  meta?: { mode?: number; symlinkTarget?: string; encoding?: "utf8" | "opaque" };
  // OpaqueFragment fallback: any Cell may store byte-exact `content` even when a
  // higher facet (ast) cannot be produced; `facet:"bytes"` is the universal floor.
}

// A Weave is a tree: an ordered, path-keyed map of entries. It represents a directory.
interface Weave {
  kind: "weave";
  entries: Record<string /*path segment*/, WeaveEntry>;
}
type WeaveEntry =
  | { type: "cell"; cid: Cid } // a file/leaf Cell
  | { type: "weave"; cid: Cid } // a subtree
  | { type: "gitlink"; target: Cid }; // submodule-class pointer (P1 interop)

// A State is a whole-tree snapshot: the root Weave plus content-addressed metadata.
interface State {
  kind: "state";
  root: Cid; // -> Weave
  identIndex: Cid; // -> IdentityIndex (NodeIdent -> path), enables O(1) move detect
  createdAt: string; // RFC3339, informational only (not part of identity semantics)
}

// A Transform is THE unit of change (see §3 for ops/algebra).
interface Transform {
  kind: "transform";
  parents: Cid[]; // lineage edges (usually 1; >1 for reconciliation)
  baseState: Cid; // -> State this Transform was authored against
  resultState: Cid; // -> State produced by applying ops to baseState
  ops: Op[]; // STOP operations (§3.2)
  effects: Effect[]; // declared effects (§3.3), verified against ops at admission
  intent: Cid; // -> Intent
  author: Did; // §9 identity
  recipe?: Cid; // -> Recipe (present => reapply-eligible, §3.6)
  provenance: Cid[]; // -> DSSE attestation envelopes (§9.6)
  authoredAt: string;
  sig: Signature; // author signature over the canonical header (excl. sig)
}

// A Line is a named moving pointer to a State + lineage. Two kinds.
interface Line {
  kind: "line";
  name: string; // e.g. "line:shared:main" | "line:local:agent-7/remediate"
  scope: "local" | "shared";
  head: Cid; // -> Transform (tip)
  controller?: Did; // shared lines: the admission authority root (grants chain to it)
}

// An Intent is a first-class, machine-readable goal + acceptance criteria.
interface Intent {
  kind: "intent";
  title: string;
  criteria: IntentCriterion[];
  author: Did;
}
type IntentCriterion =
  | { kind: "attestation"; statement: string } // "security-team ratifies"
  | { kind: "check"; statement: string; check: Cid }; // -> Recipe producing a verdict
```

### 2.3 Stable identity (NodeIdent) — the rename/move solution

Git detects renames _heuristically at diff time_ and never stores identity. AFOM assigns
each Cell a **NodeIdent** at creation that is carried through moves, so identity is a fact,
not a guess.

```
NodeIdent = "nid:" + base32( sha2-256( birthContext ) )
  birthContext = { creatingTransformCid, creationOrdinal, initialPath }  // stable, unique
```

- `move_node`/rename changes the Cell's _path in the Weave_ and updates the `IdentityIndex`
  (`NodeIdent -> currentPath`), but the Cell's `ident` and (if content unchanged) its
  `content` CID are unchanged. **No similarity heuristic is ever used.**
- The `IdentityIndex` in each `State` gives O(1) "where is nid now" and O(1) move detection
  between two States (compare index entries), which detectors and merge rely on (§3, §5).
- Consequence tested in §12: after a pure move, the moved Cell's content CID is byte-identical
  and rename detection is exact (fabric→git export is lossless; git→fabric import only
  recovers git's guessed rename — asymmetric fidelity, documented in §13).

### 2.4 Literal example object (a text Cell + its Weave entry)

```json
// Blob (content of src/util.ts), dag-cbor shown as JSON for readability
{ "kind":"blob", "size":812, "inline":"<utf8 bytes>" }              // -> bafyBlobUtil

{ "kind":"cell", "facet":"text", "ident":"nid:2h7f…",
  "content":"bafyBlobUtil", "meta":{"mode":33188,"encoding":"utf8"} }  // -> bafyCellUtil

{ "kind":"weave", "entries":{
    "src": { "type":"weave", "cid":"bafyWeaveSrc" } } }              // -> bafyWeaveRoot
// where bafyWeaveSrc.entries["util.ts"] = { "type":"cell", "cid":"bafyCellUtil" }

{ "kind":"state", "root":"bafyWeaveRoot", "identIndex":"bafyIdx", "createdAt":"2026-07-06T…" }
```

### 2.5 State = deterministic fold of history (no stored working copy)

Current state is defined as a **fold** over the Transform DAG from genesis:
`fold(genesisState, [T1..Tn]) = Tn.resultState` where each `Ti.baseState == T(i-1).resultState`
on a linear Line. This is verifiable: re-executing `fold` from genesis must reproduce the
head State CID bit-for-bit (a determinism-replay test, §12). Working copies for toolchains
are _materialized_ from a State on demand (§4.7 / App working-copy notes), never the source
of truth.

---

## 3. Transform algebra & `reapply` (STOP)

STOP (Semantic Transform & Operation Protocol) defines the operations a Transform is made
of, how facts are derived from them (dual-lane), and the `reapply` operation.

### 3.1 Operation set (the `Op` union)

```ts
type NodeSelector = { nid: NodeIdent } | { path: string }; // resolve via State.identIndex

type Op =
  | { op: "put_cell"; facet: CellFacet; ident: NodeIdent; at: string /*path*/; content: Cid }
  | { op: "delete_cell"; sel: NodeSelector }
  | { op: "move_cell"; sel: NodeSelector; to: string /*new path*/ } // identity preserved
  | { op: "put_prop"; sel: NodeSelector; key: string; value: Cid } // mode, symlink, etc.
  | { op: "patch_chunk"; sel: NodeSelector; range: [number, number]; content: Cid } // sub-blob text edit
  | { op: "put_node"; sel: NodeSelector; nodePath: string; value: Cid } // SEMANTIC lane (AST node)
  | { op: "delete_node"; sel: NodeSelector; nodePath: string } // SEMANTIC lane
  | { op: "put_artifact"; ident: NodeIdent; at: string; blob: Cid }; // generated/binary output
```

Each op has **preconditions** (checked at apply) and **postconditions** (checked to derive
`resultState`). Examples:

| op                       | precondition                         | postcondition                                                        |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------- |
| `put_cell`               | `at` free, or existing cell replaced | Weave has cell at `at` with `ident`; `identIndex[ident]=at`          |
| `delete_cell`            | `sel` resolves                       | cell removed; `identIndex[ident]` removed                            |
| `move_cell`              | `sel` resolves; `to` free            | path changes; **same `ident` & content CID**; `identIndex[ident]=to` |
| `patch_chunk`            | range within blob; facet=text/bytes  | new content CID = spliced blob                                       |
| `delete_node` (semantic) | AST node exists at `nodePath`        | AST updated; **and** projected text updated (see 3.5)                |

Applying an absent-node op is a typed error (`OpPreconditionFailed`), never a silent no-op.

### 3.2 Declared effects vocabulary

`Transform.effects` is a set drawn from a closed, versioned vocabulary. At admission,
declared effects are checked to be a **superset** of the effects implied by `ops`
(under-declaration ⇒ rejected; over-declaration ⇒ allowed but flagged).

```
Effect ∈ {
  adds_dependency, bumps_dependency_major, bumps_dependency_minor, removes_dependency,
  adds_migration, deletes_migration,
  deletes_test, skips_test, weakens_assertion, reduces_coverage_threshold,
  changes_ci, touches_sensitive_path, adds_secret_like_value,
  moves_cell, adds_generated_artifact, edits_source, deletes_source
}
```

`effectBoundsOf(effects) -> EffectBounds` (a pure, tested projection, §16 Q8) yields the
bounds a Grant authorizes against (§9.5): `{ maxCellsTouched, allowDelete, allowSensitive,
allowedEffectKinds }`.

### 3.3 Dual-lane model & the fact-authority rule

Every Transform has a **TEXT lane** (mandatory: the byte-exact result, always present via
the `bytes`/`text` facet) and an optional **SEMANTIC lane** (`ast`/structured ops for
instrumented authors/languages). The lanes must agree by construction:

- **Projection invariant:** for any Cell with a semantic facet, `reconstruct(ast) == bytes`.
  This is enforced at `Fabric.put` — a Cell whose reconstructed bytes do not equal its
  `bytes` facet is **rejected** (a lossy facet cannot enter the store). Property-tested in §12.
- **Fact-authority / disagreement rule (fail-closed):** the **TEXT lane decides all blocking
  facts.** The semantic lane may only **add** findings or **raise** severity/confidence; it
  may **never clear or lower** a text-derived blocking fact. If the semantic lane says "safe"
  and the text lane says `deletes_test`, the text fact wins and blocks. This mirrors the
  existing `confidenceCanBlock` design.

### 3.4 Transform serialization (end to end)

```
1. Author computes ops against baseState; applies them to derive resultState (State CID).
2. Author sets effects (>= implied), intent CID, optional recipe CID.
3. Canonical header = dag-cbor of Transform minus `sig`.
4. sig = Ed25519(authorKey, sha2-256(canonicalHeader)).   // key valid at authoredAt (§9.2)
5. Fabric.put(Transform) -> transformCid.  Provenance envelopes (§9.6) reference this CID.
```

### 3.5 `reapply` algebra

`reapply` rebases the **intent/transformation**, not the diff. It is defined only when
`Transform.recipe` is present.

```ts
interface Recipe {
  engine: string;              // e.g. "dep-bump" | "codemod:jscodeshift" | "sed-rule"
  determinismClass: "pinned" | "environment-sensitive" | "nondeterministic";
  toolchain: ToolchainLock;    // pinned tool digests (CIDs) — see 3.7
  rule: Cid;                   // the transformation program (a Blob)
  inputSelector: NodeSelector[]; // which cells the rule reads/writes
  expectedResultDigest?: { sha256: string }; // optional pin of the authored output
}

reapply(t: Transform, newBase: State) -> ReapplyOutcome
```

Semantics: re-execute `t.recipe.rule` under `t.recipe.toolchain` against `newBase`
(restricted to `inputSelector`), producing `candidateState`. Outcomes:

```ts
type ReapplyOutcome =
  | { kind: "CleanReapply"; resultState: Cid; recomputed: true } // rule ran; result derived from newBase
  | { kind: "Divergence"; expected: Cid; actual: Cid; report: Cid } // rule ran but output != authored intent shape
  | {
      kind: "HardFailure";
      reason: "precondition" | "toolchain_mismatch" | "engine_error";
      detail: string;
    };
```

- **CleanReapply** — the rule applied to `newBase` succeeds and (if `expectedResultDigest`
  set) matches the invariant shape; `resultState` is the _recomputed_ State. Divergent base
  edits that don't conflict with the rule's input set are absorbed automatically.
- **Divergence** — the rule ran but produced something outside the authored intent (e.g. a
  human hand-edited a target cell in a way the rule now transforms differently). Never
  silently accepted: emits a `report` object for human/agent adjudication.
- **HardFailure** — preconditions gone, toolchain digest mismatch (determinism self-check
  failed), or the engine errored. Falls back to text 3-way merge over LCA (git-class).

`reapply` only _wins_ when `determinismClass == "pinned"`. For `nondeterministic` recipes it
is not attempted (the Transform degrades to a recorded text diff, honesty constraint 3).

### 3.6 Worked example — a codemod across N files, base advances

Authored change `T1`: a codemod `renameFn: foo(x) -> foo(x, ctx)` across 40 cells, recipe
`engine:"codemod:jscodeshift"`, `determinismClass:"pinned"`, `rule = bafyRule`,
`toolchain = {jscodeshift@X (digest), node@Y (digest)}`. `T1.baseState = S0`.

While `T1` is in review, `S0 -> S1` lands a **conflicting** hand edit: a teammate changed
`callers/a.ts` to add a new call `foo(y)` (which the codemod must also rewrite).

- **git 3-way merge** over LCA `S0`: `callers/a.ts` was changed by both sides (codemod
  rewrote existing calls; human added `foo(y)`) → **textual conflict** requiring manual
  resolution, and the human's new `foo(y)` is _not_ transformed (the codemod already ran).
- **Loom `reapply(T1, S1)`**: re-executes `renameFn` against `S1`. The rule now sees
  `foo(y)` too and rewrites it to `foo(y, ctx)`. Outcome `CleanReapply` with a recomputed
  `resultState` where **all** calls — including the human's new one — are correctly
  transformed. No conflict; the intent ("rename this function everywhere") is preserved
  rather than the diff.

Objects produced: `T1'` with `baseState = S1`, recomputed `resultState = S2'`, same
`recipe`/`intent`, new `provenance` (a fresh `loom.agent-run`/`deterministic-check` for the
reapply run), `parents = [T1]` (the reapply is lineage-linked to the original intent).

### 3.7 Determinism boundary (which facts are replayable vs attested)

- **Replayable-by-content-hash (may block):** any fact that is a pure function of
  content-addressed inputs under a pinned detector. Cache key:

  ```
  factCacheKey = sha2-256( DETECTOR_REGISTRY_VERSION
                         ⧺ baseState.cid ⧺ resultState.cid
                         ⧺ diffViewDigest ⧺ toolchainDigest ⧺ policyVersionHash )
  factCid = Fabric.put(VerifiedFact[])   // re-derivable by re-running loom-detect@version
  ```

  These map to `confidence ∈ {verified, observed}` and are the **only blockable** facts.

- **Attested point-in-time (never blocks):** anything depending on wall-clock, network,
  locale, tool nondeterminism, benchmark numbers, or LLM output. Recorded as attestations
  with the captured environment; map to `confidence ∈ {attested, inferred}`.

`ToolchainLock` digests are part of the key so a tool upgrade invalidates the cached facts
(forces re-derivation), preserving reproducibility.

---

## 4. Governance write-path (RATP) & re-homing

RATP (Ratification & Admission Protocol) is where **governance becomes the write path**.
Local authoring is instant and ungoverned; entering a **Shared Line** runs the full
AgentForge evaluator atomically.

### 4.1 Two-tier write model

- **Local Line append** — `O(1)`: content-address the Transform, add a lineage edge. No
  coordination, no governance. Target `< 20ms`. Agent fleets author fully concurrently on
  isolated Local Lines (zero contention).
- **Shared Line admission (Ratification)** — the governed event. Serialized per Shared Line
  via optimistic concurrency (expected-head CAS). Target `p50 < 2s`, `p95 < 3s`. Throughput
  scales by **sharding Shared Lines** (per service/package); a single hot Line serializes
  (the same limit git monorepo merge-queues face — conceded).

### 4.2 Admission pipeline (pseudocode)

```
ratify(req: AdmissionRequest) -> Ratification | Rejection:
  # req = { line, headTransform, intent, expectedLineHead, grantChain[], attestations[], idempotencyKey }
  assertIdempotent(req.idempotencyKey)                      # dedupe (returns prior result if seen)
  line   := loadShared(req.line)
  if line.head != req.expectedLineHead: return RebaseRequired(lca(line.head, req.headTransform))
  ts     := collectTransformSet(req.headTransform)          # tip back to LCA(line.head)
  base   := lca(line.head, req.headTransform).resultState

  # 1. structural validation
  verifyTransforms(ts)                                      # sigs, effects⊇implied, resultState folds
  # 2. authorization (Grants replace CODEOWNERS/OAuth authority)
  for t in ts: authorize(req.grantChain, t.author, t.effects, cellsTouched(t), line.controller)
  # 3. derive facts (REBUILT detectors over the Fabric diff view)
  diff   := fabricDiffView(base, ts.resultState)            # ChangedFile[]-shaped, from Fabric not GitHub
  facts  := detect(diff, base, ts)                          # VerifiedFact[]  (REUSED type)
  # 4. governance evaluation (REUSED evaluator, unchanged logic)
  result := evaluateTransformSet(ts, base, facts, policyForLine(line))   # -> PolicyResult
  # 5. evidence + reviewers (REUSED)
  evidence  := resolveEvidence(result.requiredEvidence, ts, req.attestations)
  reviewers := routeReviewers(result.requiredReviewers, req.grantChain)  # Grant-based ownership
  # 6. decision
  status := decide(result, evidence, reviewers)             # pass | warn | block
  ccr    := buildChangeControlRecord(line, ts, base, result, evidence, reviewers, status)  # REUSED shape
  if status == block and not overridden(req): return Rejection(ccr)
  # 7. atomic admit: two-phase
  writeAhead(ts, ccr, ratification, ledgerLeaf)             # durable, not yet head
  casHeadOrAbort(line, expected=req.expectedLineHead, next=req.headTransform)  # serializable flip
  ledger.append(ledgerLeaf); signCheckpoint(); gatherWitnessCosigs()          # §8
  return Ratification(ccr, ledgerLeaf)
```

### 4.3 Concrete re-homing (BEFORE → AFTER)

| Package              | BEFORE (git/GitHub-typed, real today)                                                                              | AFTER (Loom-native)                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/scm.ts`        | `ScmProvider.fetchPullRequestInput(env): PullRequestInput` (needs `headSha`, `baseBranch`, `changedFiles[].patch`) | **deleted** for native; a `git-bridge` `LoomProvider` implements it only in the P2 interop seam                                                                             |
| `core/types.ts`      | `VerifiedFact.source: "github_diff" \| "github_metadata" \| …`                                                     | `source: "transform_effect" \| "fabric_diff" \| "fabric_metadata" \| "recipe" \| "attestation" \| "user_attestation"`                                                       |
| `policy/evaluate.ts` | `evaluateMergeGuard(pr: PullRequestInput, facts, policy): PolicyResult`                                            | `evaluateTransformSet(ts: TransformSet, base: Weave, facts: VerifiedFact[], policy): PolicyResult` — **body unchanged**; only the input shape and `apply_to` scoping change |
| `policy` `apply_to`  | `repo:` / `base:` / `head:` / `branch:` / `label:` globs                                                           | `line:` / `cell:` (path or nid selector) / `effect:` / `intent-label:` selectors                                                                                            |
| `evidence/index.ts`  | `findEvidenceInPrBody(body)`                                                                                       | `findEvidenceInProposal(intent, attachments, attestations)` — PR-body scrape → Intent + attached attestations                                                               |
| `reviewers/index.ts` | `routeReviewers(reqs, reviews, codeowners, teamMemberships)`                                                       | `routeReviewers(reqs, grantChain)` — routing logic **reused**; CODEOWNERS parser + GitHub team/review validators **discarded** (§5/§6)                                      |
| `records`            | `ChangeControlRecord{ pullRequestNumber, headSha, baseBranch, repositoryFullName }`                                | `ChangeControlRecord{ proposalId, stateCid, lineRef, attestationCids[], ledgerEntryId }` (other fields reused verbatim)                                                     |

`evaluateTransformSet` keeps `PolicyResult`, `VerifiedFact`, `EvidenceRequirement`,
`ReviewerRequirement`, `strictestMode`, and `confidenceCanBlock` **byte-identical**. The
evaluator does not know or care that the substrate changed.

### 4.4 Grant-based ownership (replacing CODEOWNERS + reviews)

`authorize(grantChain, actor, effects, cellsTouched, controller)` (full schema §9.5) checks
that a capability chain rooted at the Shared Line's `controller` authorizes `actor` to apply
`effects` over `cellsTouched`. Reviewer requirements are satisfied by a `human-approval`
attestation (§9.6) signed by an Actor holding a Grant over the affected Cells — the
deterministic equivalent of a CODEOWNERS-required approval, but signed and ledgered.

---

## 5. Detector rebuild

Detectors are AgentForge's differentiator and today they **are** the diff parsers
(`packages/detectors` regexes over `ChangedFile.patch`). They must be rebuilt to consume the
**Fabric diff view** (`fabricDiffView(base, result) -> ChangedFile[]`, which reconstructs
git-`ChangedFile`-shaped entries from Fabric, so the _fact logic_ is reusable) plus the
**effects/semantic lane** when present. The `VerifiedFact` output type is unchanged.

Three rebuilt detectors (dual-lane: prefer effects/semantic, fall back to text):

```
detectTestDeleted(diff, ts):
  # SEMANTIC/EFFECT lane (authoritative-eligible): a Transform declaring `deletes_test`
  facts = []
  for t in ts where t.effects includes deletes_test:
     for op in t.ops where op is delete_cell and isTestPath(resolve(op.sel)):
        facts += VerifiedFact{ type:"test_deleted", source:"transform_effect",
                               path:resolve(op.sel), confidence:"verified", severity:"high" }
  # TEXT lane fallback (when no effects/semantic present): reuse existing heuristic on diff
  for f in diff where isTestPath(f.filename) and f.status=="removed":
     facts += VerifiedFact{ type:"test_deleted", source:"fabric_diff", path:f.filename,
                            confidence:"verified", severity:"high" }
  return dedupe(facts)   # text lane may only ADD/RAISE, never clear (fail-closed)

detectDependencyAdded(diff, ts):
  # Prefer effects: a Transform op that put_cell/patch_chunk a manifest with adds_dependency
  # Parse the manifest Cell's structured facet if present; else parse the text blob (reuse
  # existing parsePackageJsonDeps / parseRequirements over the Fabric blob bytes).
  # Emit VerifiedFact{ type:"dependency_added"|"dependency_bumped", source:"transform_effect"|"fabric_diff",
  #                    confidence:"verified", metadata:{name,from,to,major} }

detectSensitivePathChanged(diff, ts, policy):
  # A Cell whose path (or nid's current path) matches policy.sensitive_paths[].paths.
  # Path comes from the Weave/identIndex (exact), not from a diff header guess.
  # Emit VerifiedFact{ type:"sensitive_path_changed", source:"fabric_metadata",
  #                    path, confidence:"verified" } for each matching touched Cell.
```

Key wins from the rebuild: paths are **exact** (from the Weave/identIndex, not a parsed
`+++ b/…` header); renames are **known** (nid) rather than heuristic; and effect-declared
facts are `verified` by construction. The text-lane fallback guarantees parity with the
current GitHub path (measured at the P2 exit gate: detector parity = 100% on
`fixtures/repos`, §12).

---

## 6. Persistence schema migration

The Prisma schema is PR/SHA-shaped. The migration re-keys the governance tables onto Loom
primitives and retires the GitHub-specific tables.

### 6.1 Model-by-model fate (against the real `schema.prisma`)

| Model (today)                                                                       | Fate                                                                                                            | Change                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Repository{ githubRepositoryId, fullName, defaultBranch }`                         | **transform** → `Space{ id, spaceDid, name }` (+ `Line{ id, spaceId, name, scope, headCid }`)                   | tenancy anchored on `Space`/`Actor`, not GitHub install                                             |
| `PullRequest{ githubPullRequestId, baseBranch, headBranch, headSha, mergedAt }`     | **transform** → `Proposal{ id (proposalId:string), lineId, headTransformCid, baseStateCid, intentCid, status }` | index `[lineId, headTransformCid]`                                                                  |
| `Evaluation{ headSha, … }`                                                          | **transform** → `Evaluation{ stateCid, … }`                                                                     | key `headSha`→`stateCid`                                                                            |
| `ChangeControlRecord{ pullRequestNumber, headSha, baseBranch, repositoryFullName }` | **transform**                                                                                                   | → `{ proposalId, stateCid, lineRef, ledgerEntryId, attestationCids Json }`; all other fields reused |
| `AuditEvent`, `ExportJob`, `PolicyVersion`                                          | **reuse**                                                                                                       | re-key `pullRequestId`→`proposalId`; add `ledgerEntryId?`                                           |
| `OwnerMapping` (CODEOWNERS-derived)                                                 | **replace** → `Grant{ … }` (§9.5)                                                                               | one-shot importer seeds Grants from CODEOWNERS at P2                                                |
| `GitHubInstallation`                                                                | **delete** (P4)                                                                                                 | tenancy via `Space`/`Actor`; kept only during P2 interop                                            |
| `CheckRun{ githubCheckRunId, conclusion }`                                          | **delete** (P4)                                                                                                 | replaced by ledgered `Ratification` + attestations                                                  |
| `WebhookDelivery{ deliveryId, event, action, payloadJson, replayCount }`            | **replace** → `AdmissionEvent{ idempotencyKey, requestJson, result }`                                           | RSP/RATP events replace webhook ingestion; replay → idempotent re-submit                            |

### 6.2 New tables

`Space`, `Line`, `Proposal`, `Grant`, `LedgerLeaf{ index, prevLeafHash, event, parentHead,
newHead, ratificationCid, attestationCids Json, checkpointSig }`, `WitnessCosignature{
leafIndex, witnessDid, sig }`, `Actor{ did, docCid, status }`. Fabric objects themselves
live in a content-addressed object store (blob storage / S3-class + a `FabricObject{ cid,
codec, size }` index), **not** as relational rows.

### 6.3 `proposalId:number → string` is a real migration, not a rename

`pullRequestNumber` is a `number` correlation key across `records`, `audit`, and migrations.
Moving to `proposalId:string` (a ULID or the head Transform CID) changes column types and
foreign keys across several tables. Sequence: **expand** (add nullable `proposalId` columns

- new tables) → **backfill** (idempotent: seed `proposalId` from a deterministic
  `git:<repo>#<pr>` namespace for imported data; seed `Grant` rows from `OwnerMapping`) →
  **dual-write** (write both keys during P2/P3) → **contract** (drop `pullRequestNumber`,
  GitHub tables after P4 cutover). Reversible until parity dashboards are green.

---

## 7. Distribution (RSP)

RSP (Replication & Sync Protocol) replaces `git fetch`/`push`. Transport is HTTP/2 (gRPC or
gRPC-web); payloads are dag-cbor. All object transfer is content-addressed and idempotent.

### 7.1 Operations

```
# Content-addressed object transfer
HasObjects(cids[])            -> { missing: cids[] }
GetObjects(cids[])            -> stream<{ cid, bytes }>          # verifyAddress on receipt
PutObjects(stream<{cid,bytes}>) -> { stored: cids[], rejected: [{cid, reason:"HashMismatch"}] }

# Streaming change session (author a Transform incrementally)
OpenChange(line, baseState, idempotencyKey) -> changeSessionId
AppendOps(changeSessionId, ops[], opSeq)     -> { ackSeq }       # per-op dedupe by opSeq
SealChange(changeSessionId, intent, recipe?, provenance[]) -> transformCid

# Admission & lines
SubmitProposal(AdmissionRequest)   -> Ratification | Rejection | RebaseRequired{lca}
Integrate(proposalId)              -> Ratification                # idempotent
SubscribeLine(line, sinceIndex)    -> stream<LedgerLeaf>          # replaces webhooks
```

### 7.2 Idempotency, concurrency, back-pressure

- **Idempotency:** `(replicaId, idempotencyKey)` for mutating calls; content-addressed
  writes are naturally idempotent (same CID = no-op); per-op `opSeq` dedupes stream appends.
- **Optimistic concurrency:** `SubmitProposal` carries `expectedLineHead`. On mismatch the
  server returns `RebaseRequired{ lca }`; the client rebases (or `reapply`s, §3.5) onto the
  new head and resubmits. This is a CAS, analogous to `--force-with-lease`, but the loser
  never overwrites — it rebases.
- **Back-pressure:** HTTP/2 flow-control windows plus an application **credit** scheme
  (server grants N in-flight object credits); exhaustion returns `QuotaExceeded` with
  `Retry-After`. Typed error model: `HashMismatch`, `RebaseRequired`, `QuotaExceeded`,
  `WitnessQuorumUnmet`, `Unauthorized`, `OpPreconditionFailed`, each mapped to an HTTP status.

### 7.3 Offline, partition, divergence, reconciliation

- **Offline authoring:** Local Lines require no server. An agent authors Transforms locally
  (content-addressed), then syncs objects (`PutObjects`) and `SubmitProposal` on reconnect.
- **Partition / two divergent heads on a _federated_ Shared Line:** detected at checkpoint
  time by the witness consistency check (§8) — two admitted heads at the same logical
  position raise **exactly one** `SplitViewEvidence` tripwire and **block further admission**
  until healed. Healing is a **governed `line.reconcile` Transform**: `parents = [H1, H2]`,
  `baseState = lca(H1,H2).resultState`, ops = the reconciliation (text 3-way on the blocking
  path; `reapply` where recipes allow). It goes through RATP like any other admission — **the
  merge is never silent**. Duplicate/replayed leaves are idempotent by CID + inclusion proof.

---

## 8. Ledger, witnesses & trust

The Ledger is a **Merkle append-only log** (RFC 6962 tree math) of admitted Transforms and
checkpoints. It is the trust anchor that replaces "trust GitHub."

### 8.1 Leaf, tree head, proofs

```ts
interface LedgerLeaf {
  index: number;               // 0-based position
  event: "ratify" | "reconcile" | "grant" | "revoke" | "actor-update";
  parentHead: Cid; newHead: Cid;   // line head transition (for ratify/reconcile)
  ratification?: Cid;              // -> CCR/Ratification object
  attestations: Cid[];             // EXACT admitted attestation set (triple-binding, §9.7)
  grantChain?: Cid[];
  prevLeafHash: Bytes;             // hash chain (defense-in-depth over Merkle)
}
interface Checkpoint {           // C2SP signed-note / signed tree head
  origin: string; treeSize: number; rootHash: Bytes; // RFC6962 Merkle Tree Hash (MTH)
  signatures: Sig[];             // log signature + witness cosignatures (§8.2)
}
// Proofs (RFC 6962):
inclusionProof(index, treeSize)   -> Bytes[]  // audit path; length = ⌈log2(treeSize)⌉
consistencyProof(m, n)            -> Bytes[]  // append-only proof between sizes m<n
```

`verifyInclusion(leafHash, index, treeSize, proof, rootHash)` and
`verifyConsistency(m, rootM, n, rootN, proof)` are the standard RFC 6962 verifiers (tested
against independent reference vectors, §12). The log is served as **tlog-tiles** (C2SP) for
efficient fetch.

### 8.2 Witnesses & fork-consistency

Tamper-evidence (Merkle) is **not** fork-consistency: a malicious log could show different
clients different trees ("split view"). Defense = a **k-of-n witness quorum** (CT / sigsum
model) that co-signs checkpoints:

- A checkpoint is valid to a client only with **≥ k witness cosignatures** over a **single
  consistent** tree head, plus a consistency proof from the client's last-seen head.
- Witnesses **gossip** heads and refuse to cosign a checkpoint that is inconsistent with one
  they already signed (this is what makes split-view detectable). Threat model: honest
  witness majority (`k > n/2`; or `n = 3f+1` for BFT cosign).
- **Client verification (offline-capable):**
  ```
  verifyOffline(bundle, trustRoot):
    verifyAddress on every object                       # integrity
    assert leaf.attestations covers the object set      # nothing dropped
    verify checkpoint log-signature under trustRoot.logKey
    assert >= k valid witness cosignatures over the SAME (treeSize, rootHash)
    verifyInclusion(leaf) ; verifyConsistency(lastSeen, checkpoint)
    # zero network; target < 5ms for n <= 1e6
  ```

### 8.3 Honest single-tenant degradation

In a **single-tenant, self-hosted** deployment (AgentForge's current shape) the org runs the
log **and** the witnesses, so cosigning is theater: it provides **internal tamper-evidence**,
not fork-consistency against the operator. This is stated plainly and is **kill-gate G1**:
if the deployment topology is single-tenant, Loom ships as _"tamper-evident governance
ledger"_ and does **not** claim host-independent trust. Fork-consistency is load-bearing
only in a **federated / multi-party** topology (multiple mutually-distrusting admission
authorities + external witnesses), which is a P5 concern.

---

## 9. Identity, Grants & provenance (PXP / PAL)

### 9.1 Actor identity — `did:loom`

Actors (human | agent | automation) are DIDs. `did:loom` is a ledger-anchored DID: the DID
document (public keys, service endpoints) is a Fabric object whose updates are **ledgered**
(`event:"actor-update"`), giving point-in-time key resolution.

```ts
interface ActorDocument {
  did: Did; actorType: "human" | "agent" | "automation";
  keys: { id: string; type: "Ed25519"; publicKeyMultibase: string; validFrom: string }[];
  platformBinding?: PlatformBinding;   // §9.2
  prev?: Cid;                          // previous doc (KERI-style pre-rotation)
}
resolveAt(did, ledgerIndex) -> ActorDocument   // pure fold over actor-update leaves <= index
```

Signature verification is **point-in-time**: a Transform's `sig` is checked against the key
valid at the ledger index where it was admitted, not "latest." Rotation uses KERI-style
pre-rotation (each doc commits to the next key's hash); revocation is a ledgered
`actor-update` marking a key `revoked`.

### 9.2 Stronger (still-not-proof) agent binding — `PlatformBinding`

An agent Actor may bind its key to a hardware/CI root: AWS Nitro / TPM2 / SEV-SNP / TDX
attestation, or an OIDC identity (e.g. GitHub Actions OIDC), or WebAuthn for humans. This
raises the bar from "someone holds the key" to "this key ran in this attested environment"
— but it is still **attested, not proof of which model produced which bytes** (honesty
constraint 1). Recorded as `platformBinding` in the ActorDocument and referenced by
`loom.agent-run` attestations.

### 9.3 Grants — capability tokens (replacing OAuth scopes + CODEOWNERS)

```ts
interface Grant {
  // UCAN/biscuit profile
  issuer: Did;
  audience: Did;
  transformTypes: string[]; // e.g. ["put_cell","move_cell"] or ["*"]
  cellSelectors: NodeSelector[]; // path globs or nids the audience may touch
  effectBounds: EffectBounds; // { maxCellsTouched, allowDelete, allowSensitive, allowedEffectKinds }
  caveats?: Caveat[]; // e.g. time window, requires-attestation-kind
  expiry: string;
  nbf?: string;
  delegationChain: Cid[]; // proof back to a root authority (Line.controller)
  sig: Signature;
}
```

**Authorization check at admission (`authorize`)** — a Grant chain authorizes a Transform iff
every hop is properly delegated (`issuer[i+1] == audience[i]`), the chain roots at the Shared
Line's `controller`, and the requested `(transformTypes, cellsTouched, effects)` is
**attenuated** at every hop (each capability is a subset `⊑` of its parent). Undecidable
selector globs fail **closed**. Revocation is ledgered (`event:"revoke"`) and checked at the
admitted index.

```
authorize(chain, actor, effects, cells, controller):
  assert chain[0].issuer == controller
  for i in 0..len(chain)-1:
     assert verify(chain[i].sig) and not revokedAt(chain[i], nowIndex)
     if i>0: assert chain[i].issuer == chain[i-1].audience and chain[i] ⊑ chain[i-1]
  leaf := chain[-1]
  assert leaf.audience == actor and expiry/nbf ok
  assert requestedTypes ⊆ leaf.transformTypes
  assert every cell in `cells` matches some leaf.cellSelectors      # fail-closed on undecidable
  assert effects ⊑ leaf.effectBounds
```

### 9.4 Provenance attestations (PXP / PAL) — three predicates

Provenance is carried as **DSSE envelopes** wrapping **in-toto Statement v1** subjects. The
`subject[0].digest.sha256` equals the SHA-256 embedded in the Transform's CID, pinning each
attestation to _this_ Transform. `_type`/`subject`/`digest` are [BORROWED: in-toto v1].

- **`loom.agent-run/v1`** [NOVEL] — how an AI produced the Transform: `agent.did` +
  `platformBinding`; `model` (provider/family/name, `weightsDigest` = `"undisclosed"` for
  hosted models, decoding params); `inputs` (systemPrompt/prompt/context/toolset/toolCalls
  **digests** only — raw text stored by digest + redacted summary via
  `sanitizeForMetadataStorage` unless the org opts into full retention); `run`
  (start/end, harness, transcript digest); `intent` + `producedTransform` CIDs. Honest: the
  prompt/tools/context hash deterministically; the model stays a trusted black box.
- **`loom.deterministic-check/v1`** [NOVEL — the reuse crown jewel] — signs the reused
  `VerifiedFact[]`: `checker` (did + `detectorSuiteDigest` + version), `inputs`
  (`baseState`, `headState`, `diffViewDigest`, `policyVersionHash`), `facts` (VerifiedFact[]
  **verbatim from `@agentforge/core`**), `factsDigest`, `determinism.reproducible`. Because
  the diff view + detector suite are hashed and the predicate is signed + ledgered, a CCR's
  `verifiedFindings` become **independently re-derivable** (re-run `loom-detect@version` over
  base/head, confirm `factsDigest`). This is "deterministic decides" made _verifiable_.
- **`loom.human-approval/v1`** [NOVEL] — a person accepted risk: `approver` (did + `authMethod:
"webauthn"`), `decision: "approve" | "override"`, `reviewedTransform`/`reviewedState`,
  `requirement` (maps to `ReviewerRequirement.id`+`tier`), `evidenceReviewed[]`,
  `statementDigest`. `decision:"override"` maps to `OverrideRecord`.

### 9.5 Triple DAG binding & `verifyProvenance`

Provenance cannot be silently detached because of three independent bindings: (1) **forward**
— `Transform.provenance: Cid[]` in the header; (2) **subject-pin** — the attestation subject
digest equals the Transform CID's hash; (3) **witnessed** — `LedgerLeaf.attestations[]`
records the _exact_ admitted set, immutable in the Merkle log.

```
verifyProvenance(transform, ledgerLeaf, resolveKey) -> ProvenanceReport:
  assert set(transform.provenance) ⊆ set(ledgerLeaf.attestations)     # nothing dropped at admission
  for env in fetch(ledgerLeaf.attestations):
     assert verifyEnvelope(env, resolveKey)                           # DSSE sigs under keys valid @ leaf.index
     stmt := decode(env.payload)
     assert stmt.subject[0].digest.sha256 == sha256OfCid(addr(transform))
     classify predicateType -> { agentRun?, deterministicCheck?, humanApproval? }
  return { agentRun, deterministicCheck, humanApproval, complete: requiredSatisfied }
```

The three feed the **reused** `ChangeControlRecord`: agent-run → "who authored";
deterministic-check → `verifiedFindings` (blocking facts); human-approval →
`requiredReviewers`/`decision`. CCR exports + compliance packages now carry
cryptographically-verifiable provenance instead of GitHub-scraped metadata. It proves _which
Actor (bound to which platform), which model + prompt/tool/context digests, which
deterministic checks over exactly which diff, which human accepted risk, admitted at which
ledger index_ — **not** that the code is correct or secure.

### 9.6 Borrowed / reused / novel (trust stack)

- **BORROWED:** multiformats CID/multihash; IPLD dag-cbor; Ed25519 (RFC 8032); RFC 6962
  Merkle math + proofs; C2SP checkpoint / signed-note + tlog-cosignature + tlog-tiles;
  CT/sigsum k-of-n + fork bound; W3C DID / Multikey; KERI pre-rotation; Nitro/TPM2/SEV-SNP/
  TDX/OIDC/WebAuthn; UCAN + Biscuit (capabilities); DSSE + PAE; in-toto Statement v1; SLSA
  digests; git `merge-base` LCA + diff3 3-way (on the blocking path); HTTP/2.
- **REUSED (`@agentforge/*`):** `VerifiedFact`, `ChangeControlRecord`, `PolicyResult`,
  `EvidenceRequirement`, `ReviewerRequirement`, `BLOCKABLE_CONFIDENCES`, the detectors' fact
  logic, records/exports/compliance, security storage policy.
- **NOVEL:** `did:loom` (ledger-anchored, folded DID doc); ledgered Grant revocation; the
  Loom capability shape (`transformTypes` × `cellSelectors` × `effectBounds`); governed
  `line.reconcile` fork healing; RSP application credits; the three predicates; the
  triple-binding of provenance into the DAG + witnessed leaf.

---

## 10. Module layout

New packages added to the existing pnpm monorepo, alongside the reused `@agentforge/*`
governance packages.

| Package               | Responsibility                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/fabric`     | CID/Address, dag-cbor codec, `TreeHasher` (sha2-256, agility → BLAKE3), FastCDC chunking, object store (`has`/`get`/`put`), `verifyAddress`                                     |
| `packages/afom`       | AFOM object schemas/types + `verify()` + `fold()` (State materialization)                                                                                                       |
| `packages/stop`       | Op set, effects vocabulary + effect→detector map, `TransformBuilder` (sign/address/verify), lanes + `mergeFacts`, `Recipe`/`ToolchainLock`/`NodeSelector`, `reapply` + outcomes |
| `packages/loom-diff`  | `fabricDiffView(base, result) -> ChangedFile[]` (may fold into `stop`, §16 Q1)                                                                                                  |
| `packages/identity`   | `did:loom`, keys, `ActorDocument`, `resolveAt` fold, rotation/revocation, platform binding                                                                                      |
| `packages/grant`      | `Grant`, `⊑` attenuation lattice, `authorize()`, ledgered `revoke`                                                                                                              |
| `packages/ledger`     | RFC 6962 MTH, inclusion/consistency proofs + verifiers, C2SP checkpoint, `LedgerLog`                                                                                            |
| `packages/witness`    | k-of-n cosign contract, gossip/anti-entropy, `verifyOffline`                                                                                                                    |
| `packages/provenance` | DSSE/PAE, in-toto Statement, the three predicates, `bind` + `verifyProvenance`                                                                                                  |
| `packages/ratify`     | RATP admission pipeline (consumed by `loom-hub`)                                                                                                                                |
| `packages/rsp`        | HTTP/2 framing, ops, idempotency, CAS/rebase, credits, `RspError`                                                                                                               |
| `packages/git-bridge` | `LoomProvider` (implements the legacy `ScmProvider`) + `transformSetFromGitPr` (P2 seam) + CODEOWNERS→Grant importer                                                            |

Apps: `apps/loom-hub` (Fastify RSP server + admission authority + log node + witness
endpoints); `apps/loomd` (local daemon for Local Lines/offline); `apps/loom-cli` (`loom …`);
`apps/loom-lsp-proxy` (editor/agent edit-capture → native semantic Transforms). The existing
`apps/api` mounts/proxies RSP during interop; `apps/worker` gains checkpoint-signing +
witness-cosign-gathering BullMQ jobs; the mobile consoles add an offline `verifyOffline`
screen.

Dependency edges (high level): `fabric → afom → stop`; `fabric → ledger → witness`;
`identity → grant`; `identity + fabric → provenance`; `stop + grant + ledger + provenance +
loom-diff → ratify → rsp → loom-hub`; reused `@agentforge/core → ratify`, `@agentforge/
detectors → loom-diff`; `git-bridge → {core, stop}`.

---

## 11. Phased roadmap & kill-gates

Every phase ships independently on git; trust/provenance value lands **before** any
substrate bet. "Realistic product" = **P2**. "Kill-gated substrate" = **P3+**.

| Phase                | Deliverable                                                                                                                                                                                    | Public surface                                                                               | Exit / kill-gate (measurable)                                                                                                                                                  | Effort | git/GitHub deleted                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**               | Fabric + AFOM + text lane + **byte-exact git round-trip**                                                                                                                                      | `Fabric.put/get`; `fabricDiffView`; `loom import --from-git` / `loom export --to-git`        | round-trip = **100%** on a fuzzed corpus + top-50 repos                                                                                                                        | ~10 EM | none (purely additive)                                                                                                                        |
| **P2 — THE PRODUCT** | Governance + provenance **on git**: RATP admission (atomic CAS + ledger), `loom.deterministic-check` over a git-computed diff view, Grants replace CODEOWNERS/OAuth **at the admission check** | `loom propose`/`ratify`/`grant`/`verify`; `evaluateTransformSet`; DSSE/Grant/LedgerLeaf wire | detector parity **100%** vs current GitHub path on `fixtures/repos`; admission **p95 < 3s**; ≥1 design partner governed; Grants replace CODEOWNERS/OAuth                       | ~16 EM | demote `publishMergeGuardCheckWithClient`→mirror; **delete** `auth.ts` OAuth role-mapping; demote CODEOWNERS parser → one-shot Grant importer |
| **P3**               | `reapply` + semantic lane v1 for TS/JS                                                                                                                                                         | `loom reapply`; semantic ops                                                                 | projector-eq **100%** (semantic reconstructs authoritative bytes) or auto-demote to advisory; mechanical reapply win-rate **≥90%** vs text-merge conflicts on a codemod corpus | ~12 EM | —                                                                                                                                             |
| **P4 — KILL-GATED**  | Native substrate pilot: native object plane, change sessions, native Shared Lines                                                                                                              | `OpenChange`/`AppendOps`/`SealChange`; native `SubscribeLine`                                | design partner runs a project **git-free 30 days, data-loss = 0**                                                                                                              | ~14 EM | **delete** `fetchPullRequestInputFromGithub`, webhook route, `GitHubInstallation`/`WebhookDelivery`/`CheckRun` models, worker check-publish   |
| **P5 — KILL-GATED**  | Federation + witness quorum: multi-authority admission, M-of-N checkpoints, `line.reconcile`                                                                                                   | witness endpoints; federated RSP                                                             | fork-consistency **demonstrable under partition**; **kill if** split-brain observed without detection                                                                          | ~12 EM | remaining git-bridge for migrated cohorts                                                                                                     |

Totals: shippable **P1–P3 ≈ 38 EM** (~7–8 months at 5–6 engineers); **P4–P5 ≈ 26 EM, gated**.

### 11.1 Kill-gate decision tree

- **G0** (P2): signed detector output must be reproducible across two independent runners. **Fail → STOP** (the "deterministic decides" claim is invalid; there is no product).
- **G1** (P2): if the deployment is single-tenant only → ship **"tamper-evidence only"**; do **not** claim fork-consistency (§8.3).
- **G2** (P2): if capability UX is worse than GitHub teams → keep GitHub as the authority, make **Grants advisory**.
- **G3** (P3→P4): proceed to the substrate **only** if P1–P3 show owning it unlocks what git provably cannot — measurable `reapply`-rebase wins, or a demanded federated multi-authority admission. **Else stay at P2; git is the permanent substrate.**
- **P5**: kill federation if split-brain is ever observed without detection.

Each milestone is independently shippable on git, so a kill at G3/P4/P5 does **not**
invalidate the P2 product.

---

## 12. Test & conformance strategy

- **AFOM / Fabric:** canonical round-trip (10⁴ objects byte-identical across processes);
  non-canonical encoding rejected; CID stability; Blob dedup; **rename-preserves-identity**
  (headline: `move_cell` ⇒ `identIndex` path moves, Cell CID unchanged, no similarity
  heuristic); `fold` correctness; facet byte-exactness (lossy facet rejected at `put`);
  `verifyAddress` bit-flip rejection.
- **STOP:** op pre/post laws (deleting an absent nid = typed error); effect coverage
  (under-declared effects rejected); lane monotonicity property-test (semantic add/raise
  only); **text-authority** (strip the semantic lane ⇒ identical blocking result 100%);
  serialization determinism.
- **`reapply`:** fast path (no engine exec when inputs unaffected); **recompute win** (the
  §3.6 codemod yields `foo(y, ctx)` while real `git merge-file` yields exactly one conflict —
  asserted against actual git); divergence detection never mutates the authored result;
  determinism self-check + toolchain-mismatch → `HardFailure`; no-recipe fallback to text.
- **Determinism boundary:** `factCacheKey` stability + per-field sensitivity; keyed on
  content not chunking; `DETECTOR_REGISTRY_VERSION` bump invalidates all; class assignment
  (Fabric-only ⇒ replayable/blockable, non-Fabric ⇒ attested/non-blocking).
- **RSP:** object idempotency; CAS (one admitted, other `RebaseRequired` with valid `lca`);
  rebase determinism; credit exhaustion → `QuotaExceeded`; `HashMismatch` rejection; error →
  HTTP status map. **Divergence:** LCA vs reference on random DAGs; a federated fork triggers
  exactly one tripwire and blocks until `line.reconcile` (leaf `parents=[H1,H2]`).
- **Ledger:** inclusion proof length = `⌈log2 n⌉` for `n ∈ {1,2,3,7,8,1000,10⁶}`; consistency
  for all `1 ≤ m < n ≤ 10⁴`; **CT interop** against an independent RFC 6962 verifier's
  vectors; append serialization gap-free.
- **Witness:** fork refusal + `SplitViewEvidence`; k-of-n (`k-1` ⇒ `WitnessQuorumUnmet`);
  `verifyOffline` zero-network and `< 5ms` for `n ≤ 10⁶`.
- **Identity/Grant:** point-in-time key validity; pre-rotation reject; `resolveAt` pure fold;
  Grant attenuation property-test (accept iff every hop `⊑` and covered); root-authority;
  ledgered revoke; undecidable globs fail closed.
- **Provenance:** DSSE vs reference vectors + exact PAE; subject-pin mismatch reject;
  non-detachment reject; reproducible facts + `attested` **never** flips `checkStatus`.
- **Cross-cutting:** algebra laws via fast-check (identity/determinism/invertibility/
  composition); AFOM round-trip + git byte-exact corpus fuzzing; determinism replay (re-fold
  from genesis); **RATP golden tests reusing `fixtures/repos`** + dual-run shadow parity vs
  the current GitHub path + Grant-authority goldens. Perf p95 targets: `HasObjects(1k) <
30ms`; inclusion-proof gen `< 2ms`; checkpoint sign `< 3ms`; `authorize(depth≤5) < 5ms`;
  `verifyOffline < 5ms`; **admission p95 < 3s** (P2 exit). Wired into `ci.yml` via the
  existing `test:unit`/`test:integration` split; new fixtures under
  `fixtures/{ledger,grants,attestations,forks}`.

---

## 13. Repository / history migration

Distinct from the Prisma schema migration (§6); this is git-history **import** into Fabric.

| Strategy                             | Effort                   | Gives                                                                                                       | Loses                                                                       |
| ------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| snapshot-import                      | low (~1 EM / repo class) | current tree as one genesis State; fast                                                                     | no lineage DAG, no merge-base, no `reapply` history, no provenance backfill |
| **DAG-import (recommended default)** | med (~3 EM)              | full commit DAG → Transform DAG, real LCA/merge-base, reapply-eligible history, per-commit provenance stubs | higher import cost; large-repo memory                                       |

DAG-import is the default because P2's value (real lineage/merge-base, admission provenance)
requires the DAG; snapshot-import is an escape hatch for pathological repos. Rollout uses the
expand → backfill → dual-write → contract sequence (§6.3) with idempotent backfill so cutover
is reversible until parity dashboards are green.

**Git-losslessness matrix** (P1 round-trip kill-criterion): exec-bit ✓ (mode prop); symlink ✓
(entry type); submodule/gitlink ✓ as typed pointer (recursive semantics reimplemented,
partial); empty dirs — match git's limitation (not represented); CRLF — store bytes verbatim,
disable smudge/clean; arbitrary-byte filenames — byte-preserve paths (risk on
case-insensitive FS); rename detection — fabric→git lossless, git→fabric recovers only git's
heuristic guess (asymmetric, documented).

---

## 14. Worked end-to-end scenario (spans P2 + P3)

An agent fleet remediates a lodash GHSA across 7 services.

1. **Intent:** `Intent{ title:"Remediate GHSA-xxxx lodash", criteria:[{kind:"attestation",
statement:"security-team ratifies"},{kind:"check", statement:"migration dry-run passes",
check:«recipe»}], author: did:loom:agent-fleet }`.
2. **Local Line:** each service gets 2 reproducible Transforms — `T1` dep bump
   `lodash ^4.17.20 → ^4.17.21` (recipe `engine:"dep-bump"`, `determinismClass:"pinned"`,
   `effects=[bumps_dependency_minor]`) and `T2` `add_migration` (`effects=[adds_migration]`).
   Recipes present ⇒ reapply-eligible. `loom propose --dry-run` reports `reproducible=true`.
3. **Base advances:** `main` moves during review; `reapply(T1, S_new)` re-runs `dep-bump`
   cleanly (`CleanReapply`, recomputed); a teammate's manifest edit is absorbed.
4. **Attestations:** the agent emits `loom.agent-run/v1` (model + prompt/context digests,
   `weightsDigest:"undisclosed"`, `platformBinding: gh-oidc`); the check runner emits
   `loom.deterministic-check/v1` signing the `VerifiedFact[]`.
5. **RATP propose** — `AdmissionRequest`: `{ line:"line:shared:main", headTransform:"bafy…T2",
intent:"bafy…intent", expectedLineHead:"bafy…H0", grantChain:["bafy…G0","bafy…G1"],
attestations:["bafy…agentRun","bafy…detCheck"], idempotencyKey:"ik_…" }`. Derived facts:
   `dependency_bumped` (source `transform_effect`, `verified`) + `migration_added`
   (`transform_effect`, `verified`) + `agent_signal_detected` (`fabric_metadata`, `inferred`).
   Policy hits: `dependencies.*` → `require_review(security-team)`; `database.migrations` →
   `block` + `requiredEvidence[rollback_plan, migration_dry_run]` +
   `requiredReviewer(database-owner)`. **status = block** (evidence missing, reviewers
   uncleared). Attested-not-proven: the dry-run attestation is `provided`, but human approval
   is still required.
6. **Ratify:** `loom.human-approval/v1` (webauthn) from security-team + database-owner, each
   backed by a `Grant` covering the touched Cells (`authorize()` passes: rooted in the Line
   controller, chain `⊑`, effects within bounds).
7. **Atomic admit:** two-phase — write-ahead `T2`/CCR/`Ratification`/`LedgerLeaf`, then
   serializable head-CAS flip. Re-homed CCR (JSON): `{ id, lineRef:"line:shared:main",
stateCid:"bafy…S2", transformId:"bafy…T2", verifiedFindings:[dependency_bumped,
migration_added], requiredEvidence:[rollback_plan:approved, migration_dry_run:approved],
requiredReviewers:[security-team:approved, database-owner:approved], checkStatus:"pass",
lifecycle:"admitted", attestationCids:[…], ledgerEntryId:"…" }`. Ledger leaf:
   `{ event:"ratify", index:4187, parentHead:"bafy…H0", newHead:"bafy…T2",
ratification:"bafy…", attestations:[agentRun, detCheck, humanApproval],
grantChain:[G0,G1], prevLeafHash:… }`; checkpoint signed + k-of-n witness cosigned.
8. **Offline verify:** a CI runner runs `verifyOffline(bundle, trustRoot)` — object integrity
   - leaf-covers-object + log signature + k witness cosigs + inclusion proof — zero network.
9. **Git export (P2):** byte-exact export back to git so downstream tooling is unaffected. The
   in-toto/DSSE ratification attestation is the durable, independently-verifiable record.

---

## 15. Risk register

| #   | Risk                                      | Likelihood | Impact                                   | Mitigation                                                       | Metric tie                          |
| --- | ----------------------------------------- | ---------- | ---------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| 1   | Detectors not reproducible across runners | med        | **HIGH** (kills "deterministic decides") | pin `toolchainDigest`; `factCacheKey`; dual-run shadow           | G0; §12 reproducible-facts          |
| 2   | Semantic lane byte-divergence             | med        | high                                     | `reconstruct(facet)==bytes` enforced at `put`; projector-eq test | P3 exit projector-eq=100%           |
| 3   | `reapply` wrongly "wins" (non-mechanical) | med        | **HIGH**                                 | recipe gate + determinism self-check + divergence-never-silent   | mechanical win-rate; §12 divergence |
| 4   | Single-tenant fork-consistency illusion   | high       | high                                     | honest degradation (§8.3); recommend external-domain witness     | G1                                  |
| 5   | Grant UX worse than GitHub teams          | med        | high                                     | importer seeds Grants from CODEOWNERS; advisory fallback         | G2                                  |
| 6   | Admission latency SLO miss                | med        | med                                      | off-path observe/warn; per-Line sharding; async witness          | admission p95 < 3s                  |
| 7   | Ledger CT-verifier non-interop            | low        | **HIGH**                                 | RFC 6962 verbatim; test vs independent verifier                  | §12 CT interop                      |
| 8   | Federated split-brain undetected          | low        | **HIGH**                                 | 3 tripwires + `k > n/2` + gossip; kill P5 if observed            | P5 exit                             |
| 9   | Hash migration (SHA-256→BLAKE3) churn     | low        | med                                      | `TreeHasher` abstraction; multihash agility; P4-gated            | §16 Q5                              |
| 10  | Substrate rewrite sinks cost w/o payoff   | med        | **HIGH**                                 | P4 kill-gate; P1–P3 ship on git independently                    | G3                                  |
| 11  | Provenance detachment / spoof             | low        | high                                     | triple binding + subject-pin + witnessed leaf                    | §12 non-detachment                  |

**Decision tree:** G0 fail → STOP. G1 single-tenant → ship tamper-evidence-only. G2 worse →
Grants advisory, keep GitHub authority. G3 no substrate advantage → stay P2 (git permanent).
P2/P3 ship independently; P4/P5 are killable without invalidating the product.

---

## 16. Open questions

1. Package boundary: keep `loom-diff` separate or fold into `stop`? (leaning fold; low coupling risk).
2. Does the Local-Line journal need its own hash-link, given content addressing already makes each leaf tamper-evident? (candidate simplification).
3. Semantic-lane grammar rollout order after TS/JS (Python/Go next?).
4. Single-tenant witness operation: bundle a default external witness, or require the customer to run one? (sets the G1 default posture).
5. Hash agility: freeze the exact multihash-swap procedure and dual-hash transition window before P4.
6. Glob-inclusion decidability: enumerate the fail-closed corner cases (negation, brace-expansion) and add goldens.
7. Federated multi-authority: confirm default OFF for v1 (single authority) so federation is a P5 concern, not a P2 correctness burden.
8. `effectBoundsOf()` projection: fix the exact `Effect[] → EffectBounds` mapping as a tested pure function.

> These are the only items not fully resolved in this document. The load-bearing
> architectural decisions (representation authority, ledger trust topology, concurrency
> model, and the "why build the substrate at all" graduation trigger) are committed above,
> not deferred.

---

## 17. Gap register (today → end goal)

The single dominant gap: **AgentForge has zero VCS lower-half.** It only observes GitHub
artifacts (`headSha`, `ChangedFile.patch`, PR numbers); it computes no diff, stores no
versioned content, models no history, resolves no merge. So the gap to a native agentic VCS
is not a feature list — it is **~100% of version control itself**, plus its ecosystem. The
reusable asset is the governance upper-half, and even that is git-typed at ~331 sites.

| Domain                  | Today                                  | End goal (Loom)                                    | Gap & difficulty                                                        | Brutal truth                                                                                               |
| ----------------------- | -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Content/object store    | none; consumes GitHub blobs by SHA     | Fabric/AFOM (CAS, typed Cells, stable `NodeIdent`) | invent the entire store — **huge**                                      | git's crown jewel; reimplementing it _is_ building a git-class DB                                          |
| Change representation   | parse GitHub textual patch             | Transform (typed op + intent + provenance)         | whole change model + dual-lane — **huge**                               | text lane stays authoritative → the semantic win is ~0 languages at v1                                     |
| History/lineage         | none (branches are strings)            | lineage DAG + LCA + fold                           | entire history model — **huge**                                         | LCA = merge-base; you are rebuilding git's DAG with new IDs                                                |
| Merge/concurrency       | none (GitHub merges)                   | `reapply` + text 3-way + governed reconcile        | merge engine + concurrency — **huge**                                   | general semantic merge is unsolved; fallback is text 3-way = git (see companion `reapply-merge-engine.md`) |
| Identity/authz          | GitHub OAuth/App + CODEOWNERS          | `did:loom` + Grants                                | DID method + capability system — **large**                              | attested ≠ proven; single-tenant witnesses are theater (§8.3)                                              |
| Provenance              | scraped metadata + regex agent-signals | in-toto predicates + triple binding                | attestation layer — **medium** (mostly borrowed)                        | the real novelty, but still does not prove which model wrote the code                                      |
| Distribution/sync       | GitHub webhooks                        | RSP + Ledger + witnesses                           | whole sync + trust anchor — **huge**                                    | git plumbing took ~20 years; offline/scale/perf unsolved by a small team                                   |
| Governance (reusable)   | strong: policy/evidence/CCR/audit      | re-homed onto Transforms                           | rewrite input adapters + rebuild detectors + re-key schema — **medium** | the only part with real reusable value; detectors (the differentiator) must be rebuilt                     |
| Human + tooling surface | GitHub PR UI, IDE diff, CI             | materialized working copy + native review          | entire client/tooling surface — **huge + adoption-gated**               | humans need textual diffs; compilers/CI read a filesystem; this is where it dies                           |
| Ecosystem/adoption      | rides GitHub's network                 | git-free                                           | everything (network effects) — **existential**                          | superior VCS tech (Pijul, Darcs, Fossil, Sapling) all lost to git                                          |

**Standards that must be invented** (vs. borrowed): `AFOM`, `STOP`+`reapply`, `RATP` are the
genuinely novel compositions; `PXP/PAL`, `Ledger+Witness`, `Identity+Grant` are ~90% borrowed
(in-toto/SLSA/DSSE, RFC 6962/CT, DID/UCAN). Closing the full gap ≈ 64 eng-months (P1–P5),
of which only ~38 (P1–P3, still on git) yield a shippable product; P4–P5 are kill-gated.

---

## 18. Independent stress-test & scope revision

A fresh, independent adversarial pass (claim-audit + contrarian-architect + kill-shot +
adjudicator, none allowed to rubber-stamp) reached the same conclusion **from the primary
source**: the settled verdict **HOLDS at ~0.85 confidence**, with **one downward scope
revision**. No new fatal flaw was found; the multi-pass convergence is robust, not a shared
blind spot. Three corrections supersede the plan as written:

- **18.1 The value quadrant is nearly empty.** The intersection of _valuable ∩ defensible ∩
  demanded_ is close to ∅: the defensible piece (deterministic-check reproducibility) is
  guaranteed-by-construction — a pure function + signature — hence **trivially copyable (low
  moat)**; the valuable piece (AI-authorship provenance) is **capped by the plan's own
  attested-not-proven constraint** (§9.4: `weightsDigest:"undisclosed"`, the model is a
  trusted black box); the novel-hard piece (Grant attenuation) is **pre-conceded to advisory
  at G2**. Nothing sits in all three quadrants at once. This does not overturn the plan; it
  narrows the product.

- **18.2 Integrate, do not reimplement (corrects §10 module layout and §11 P1/P4/P5).** The
  realistic build assembles the provenance/trust layer from off-the-shelf **cosign/DSSE +
  Rekor + UCAN/Biscuit + did:web/did:key**, rather than building `packages/fabric`,
  `packages/ledger`, `packages/witness`, `packages/identity`, `packages/grant` from spec.
  **Git already is a content-addressed DAG**, so `Fabric`/`AFOM` (P1) and the git-free
  substrate (P4/P5) should **not** be built for the stated single-tenant buyer. Single-tenant
  fork-consistency is recovered by an **external, second-trust-domain witness over git commit
  SHAs** — obtaining §8's guarantee without owning the substrate. Build the thin novel
  binding only if customers pay for the last ~10%.

- **18.3 The G0 kill-gate measures the wrong variable (corrects §11.1).** G0 as written
  ("signed detector output reproducible across two runners") **cannot fail** — detectors are
  pure functions over content-addressed inputs under a pinned registry, so it tests "is a
  pure function deterministic," not "will anyone pay." The first real demand signal ("≥1
  design partner governed") lands ~26 EM in, and _governed ≠ paying_. **Corrected G0:** before
  any custom build, prove a design partner will **pay** for the delta over
  CODEOWNERS + branch-protection + off-the-shelf cosign/Rekor/SLSA. If not, the 38 EM is
  uninvestable and the program stops at a spreadsheet.

- **18.4 Reapply can re-attach a stale approval (corrects §3.5; detailed in the merge-engine
  companion).** A `reapply` that changes `resultState` produces a new Transform CID, which
  breaks the provenance subject-pin (§9.5) — so a prior `human-approval` attestation must not
  carry over. **Rule:** any `reapply` whose outcome changes `resultState` invalidates prior
  human approvals and re-triggers reviewer requirements.

**Revised bottom line:** build a _narrower_ thing, gated on money not math — ship
cryptographic provenance + transparency-logged Change Control Records as a **priced
AgentForge feature assembled from existing sigstore/cosign/DSSE/UCAN/DID primitives + an
external witness over git SHAs**, with a willingness-to-pay gate in front of the build. Let
the native substrate (P4/P5) die at the corrected gate unless a federated, multi-party,
instrumented customer with a hard unbypassability requirement actually appears and pays.
