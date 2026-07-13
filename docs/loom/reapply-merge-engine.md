# Loom VCS Merge and Reapply Specification

> Specification: `0.1.0-draft`
>
> Status: normative algorithm companion
>
> Authority: refines §11 of [the core specification](loom-detailed-design.md)

This document specifies how Loom combines concurrent histories and reapplies
mechanical transformations after a base moves. The current `@agentforge/loom-core`
prototype implements LCA selection, conservative classification, text
three-way merge, typed conflicts, and a subset of Recipe reapply. Native Line,
working-copy, admission, storage, and full conformance integration remain to be
implemented.

The normative key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and
**MAY** have the meaning defined by RFC 2119 and RFC 8174.

## 0. Thesis (the honest frame — do not skip)

1. **The floor is text three-way merge over a deterministic LCA. It is mandatory and always available.**
   Everything in this document is an _optimization layered on top of that floor_, never a
   replacement for it. If any optimization is uncertain, the engine falls back to text 3-way
   and, failing that, to a typed human conflict. There is no path where the engine "loses" a
   change to a clever algorithm.
2. **Verified `reapply` is only for mechanical, pinned, hermetic transformations** — codemods,
   dependency bumps, migrations, security remediations, generated code. For creative/logic
   edits the "program" degrades to "the model emitted these bytes," i.e. a recorded diff, and
   the engine merges it with the ordinary text three-way safety floor.
3. **General semantic merge is unsolved and is NOT attempted on the blocking path.** No
   language-agnostic sound semantic merge exists; per-language AST merge
   (GumTree/Spork/Mergiraf-class) is enrichment only and can never clear a
   blocking byte-derived fact (core spec §8.3).
4. **A merge/reapply result is a new Transform and goes through shared admission.** The
   engine never silently lands anything; facts are re-derived and approvals are
   re-evaluated (§4 here).
5. **Conservatism is acceptable; silent loss is not.** Loom does not promise to
   resolve every case another VCS resolves. When equivalence cannot be proved,
   it emits a conflict rather than guessing.

## 1. Scope & vocabulary

| Term               | Meaning here                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `base`             | the LCA State of the two lineages being combined (merge-base; §2)                                      |
| `ours` / `theirs`  | the two head States (e.g. the Shared Line head vs. a proposal head)                                    |
| `Transform.recipe` | the executable transformation + pinned toolchain that makes a change reapply-eligible (core spec §7.7) |
| `reapply`          | re-execute a recipe against a new base to _recompute_ the change, instead of re-projecting an old diff |
| `merge`            | combine two lineages into one new State via a reconciliation Transform                                 |
| conflict           | a **typed, node-granular** disagreement the engine cannot resolve automatically (§2.3)                 |

The engine has two entry points: **`merge(base, ours, theirs)`** (combine two lineages) and
**`reapply(transform, newBase)`** (advance one recipe-bearing Transform onto a moved base).
`merge` uses `reapply` internally when one side has an eligible pinned Recipe
(§3.4).

## 2. The conflict model

### 2.1 Mandatory text safety floor

Base-state selection is LCA over the Loom Transform DAG. When several best
common ancestors exist, the deterministic selection rule in the core
specification applies and the candidate set is recorded. On the blocking path,
content reconciliation is diff3 text three-way over each Cell's authoritative
bytes. This is deliberately conservative and is the safety floor, not a claim
of general semantic merge.

### 2.2 What Loom adds over Git's line model: node-granular, identity-stable scoping

Text-oriented systems commonly scope conflicts to path and line ranges, and
rename identity may be inferred. Loom scopes conflicts to Cells by stable
`NodeIdent`, so:

- A change is `{ nid, facet, opKind, effect }`-typed, not "lines 40–52 of a path."
- **A pure move and a content edit can compose:** if `ours` moves `nid:X`
  (path A→B) and `theirs` only edits `nid:X`, the operations compose when the
  destination remains free and neither side deletes or independently moves the
  Cell. Identity is a stored fact rather than a similarity guess.
- Conflict blast radius is the set of overlapping `nid`s, not whole files.

### 2.3 Classification: independent vs. dependent vs. conflicting

For two Transform-sets `ΔO` (ours) and `ΔT` (theirs) over `base`, first check
cross-identity structural collisions, then classify each touched `nid`:

```
for collision in structuralPathCollisions(ΔO, ΔT):
  emit CONFLICT(collision)                     # distinct identities cannot occupy one path
for nid in touched(ΔO) ∪ touched(ΔT):
  o := opsOn(ΔO, nid); t := opsOn(ΔT, nid)
  if o == ∅ or t == ∅:               classify INDEPENDENT   # subject to structural pre-pass
  elif commute(o, t):                classify COMMUTING      # e.g. move on one side, prop on other
  elif oneSideHasEligiblePinnedRecipe: classify RECOMPUTABLE # defer to reapply (§3) instead of merging diffs
  else:                              classify CONFLICT(nid)  # needs text 3-way, then human if diff3 conflicts
```

- **INDEPENDENT** ops (disjoint `nid`s) compose when their paths and structural
  resources do not collide; this is the common fleet case for agents editing
  different services or files.
- **COMMUTING** ops on the same `nid` compose by a fixed, tested precedence
  (move → prop → content); `commute()` is a total, conservative predicate (returns `false`
  when unsure → falls through to CONFLICT → text 3-way; **fail-safe, never fail-open**).
- **RECOMPUTABLE**: at least one side has an eligible pinned Recipe whose input
  set overlaps `nid`; the engine prefers `reapply` (recompute the rule against
  the other side's result) over merging two diffs. This is Loom's
  merge-specific advantage; §3 defines it precisely.
- **CONFLICT(nid)**: reconcile the Cell's text facet with diff3; if diff3 reports a textual
  conflict, emit a **typed human conflict** (§2.4) — never auto-pick.

### 2.4 Typed human conflict (what a reviewer actually sees)

```ts
interface Conflict {
  nid: NodeIdent;
  path?: string; // current path from identIndex; absent for some path collisions
  kind:
    "content" | "binary" | "delete/edit" | "move/move" | "path-collision" | "recompute-divergence";
  base: Cid | null;
  ours: Cid | null;
  theirs: Cid | null; // the three Cell contents; null means absent/deleted
  textConflict?: { markers: string }; // diff3 <<<<<<< region, when kind=content
  effects: Effect[]; // declared effects touching this nid (for policy)
  suggestedResolution?: Cid; // from reapply Divergence report, if any
}
```

A merge with any unresolved `Conflict` cannot be admitted (§4). Resolution is a
human- or agent-authored Transform over the conflicting `nid`s, which itself re-enters
admission.

---

## 3. The `reapply` engine

### 3.1 Inputs and the recipe/engine model

`reapply(t: Transform, newBase: State)` accepts any Transform, but only a
Transform with an eligible Recipe can produce `CleanReapply`.

```ts
interface Recipe {
  engine: EngineId; // "dep-bump" | "codemod:jscodeshift" | "codemod:comby"
  //  | "sed-rule" | "migration:sql" | "formatter:prettier" | …
  determinismClass: "pinned" | "environment-sensitive" | "nondeterministic";
  toolchain: {
    engineDigest: Cid;
    runtimeDigest: Cid;
    environment: Record<string, string>;
  };
  rule: Cid; // the transformation program (a Blob) — the actual codemod/rule
  inputSelector: NodeSelector[]; // cells the rule may read
  writeScope: NodeSelector[]; // cells the rule may write (enforced; a write outside = HardFailure)
  invariants: Invariant[]; // machine-checkable post-conditions (see 3.3); may be empty
  expectedEffectFingerprint?: Cid; // optional digest of expected writes/effects, not the full State
}
```

The result is one of these closed variants:

```ts
type ReapplyOutcome =
  | {
      kind: "CleanReapply";
      resultState: Cid;
      effectFingerprint: Cid;
      recomputed: true;
    }
  | {
      kind: "Divergence";
      candidateState: Cid;
      expectedEffectFingerprint?: Cid;
      actualEffectFingerprint?: Cid;
      report: Cid;
    }
  | {
      kind: "HardFailure";
      reason:
        | "no-recipe"
        | "not-pinned"
        | "toolchain-mismatch"
        | "precondition"
        | "scope-violation"
        | "engine-error"
        | "nondeterministic-engine";
      detail: string;
    };
```

`CleanReapply` describes a verified candidate State. It does not mean that the
candidate has been authorized, approved, or admitted to a Shared Line.

**Engines** are pure, sandboxed transformers registered by the Loom implementation. An engine takes
`(rule, inputCells, env)` and returns `writeCells` or an error. Engines must be **hermetic**:
no network, no clock, no ambient filesystem — only the declared inputs and the pinned
toolchain. `determinismClass` records the honest truth about an engine+rule:

- `pinned` — hermetic and reproducible: same `(rule, inputs, toolchain)` ⇒ byte-identical
  output. **Only `pinned` recipes are eligible to _win_ a merge** (recompute instead of
  diff-merge). Examples: jscodeshift/comby codemods, `dep-bump`, deterministic formatters.
- `environment-sensitive` — depends on tool version, locale, operating system,
  or other recorded environment state. A client MAY run it to produce an
  advisory candidate, but the normative verified `reapply` path MUST reject it.
  It cannot win an automatic merge or satisfy a blocking fact.
- `nondeterministic` — LLM freeform, network, timestamps. **Never reapplied**; the Transform
  degrades to a recorded text diff and merges via text 3-way. This is the honest boundary.

### 3.2 The algorithm

```
reapply(t, newBase) -> ReapplyOutcome:
  if t.recipe is absent:                      return HardFailure("no-recipe")           # -> caller uses text 3-way
  if t.recipe.determinismClass != "pinned":  return HardFailure("not-pinned")

  # 0. toolchain self-check (determinism guard)
  if resolveToolchain(t.recipe.toolchain) mismatches available: return HardFailure("toolchain-mismatch")

  # 1. preconditions: every inputSelector resolves; writeScope may name absent creation targets
  inCells := resolveAll(t.recipe.inputSelector, newBase)
  if any unresolved:                          return HardFailure("precondition")        # target vanished -> text 3-way

  # 2. execute the rule hermetically against newBase (NOT against the old diff)
  firstWrites  := runFreshSandbox(t.recipe, inCells)
  secondWrites := runFreshSandbox(t.recipe, inCells)
  if either run errors:                        return HardFailure("engine-error")
  if digest(firstWrites) != digest(secondWrites): return HardFailure("nondeterministic-engine")
  if firstWrites escapes writeScope:           return HardFailure("scope-violation")

  # 3. build candidate State from the verified first run
  candidate := applyWrites(newBase, firstWrites)

  # 4. invariant + expected-effect checks
  actualFingerprint := effectFingerprint(newBase, candidate, t.recipe.writeScope)
  for inv in t.recipe.invariants:
      if not check(inv, candidate):
          return Divergence(candidateState=putObject(candidate),
                            expectedEffectFingerprint=t.recipe.expectedEffectFingerprint,
                            actualEffectFingerprint=actualFingerprint,
                            report=putObject(invariantReport(inv, candidate)))
  if t.recipe.expectedEffectFingerprint and
     actualFingerprint != t.recipe.expectedEffectFingerprint:
      return Divergence(candidateState=putObject(candidate),
                        expectedEffectFingerprint=t.recipe.expectedEffectFingerprint,
                        actualEffectFingerprint=actualFingerprint,
                        report=putObject(effectDiffReport(t, candidate, newBase)))

  return CleanReapply(resultState=putObject(candidate),
                      effectFingerprint=actualFingerprint,
                      recomputed=true)
```

Outcome semantics (refining core spec §11):

- **`CleanReapply`** — the rule ran hermetically, stayed in `writeScope`, passed its
  determinism self-check and invariants. `resultState` is the _recomputed_ tree. Non-conflicting
  base edits inside `inputSelector` are absorbed automatically (the rule simply sees them).
- **`Divergence`** — the rule ran but the result violated an `invariant` or the
  `expectedEffectFingerprint` (e.g. a human hand-edited a target Cell so the rule now
  transforms it into something outside the authored intent). Emits a `report` (base/expected/
  actual per `nid`) for human or agent adjudication. **Never auto-accepted.**
- **`HardFailure`** — no recipe, a Recipe not eligible for verified reapply,
  toolchain mismatch, precondition gone, scope violation, engine error, or a
  failed determinism self-check. The caller falls back to **text 3-way** over
  the deterministic LCA for the affected Cells.

### 3.3 Invariants (cheap machine checks that turn "clean" into "trustworthy")

The scariest failure is a **false clean**: the rule runs and produces plausible-but-wrong
bytes. Mitigations, in order of strength:

1. **`writeScope` enforcement** — a rule that writes outside its declared cells hard-fails.
2. **Run-twice determinism self-check** — catches a nominally-`pinned` engine that isn't.
3. **`expectedEffectFingerprint`** — pins the expected write/effect shape inside
   the Recipe's scope while excluding unrelated changes already present in the
   new base. A materially different recompute becomes `Divergence`, not silent
   success. The full result State MUST NOT be used as this fingerprint because
   legitimate new-base content would make every useful reapply diverge.
4. **`invariants`** — declarative post-conditions the engine can check on `candidate`, e.g.
   `{kind:"parses", lang:"ts"}`, `{kind:"no_new_effect", not:["adds_dependency"]}`,
   `{kind:"count_delta", selector:"call foo(", expect:">=0"}`, or `{kind:"recipe_check",
check: «a pinned verifier recipe»}`. Invariants are the bridge from "reapply is convenient"
   to "reapply is safe to auto-land under policy."

`effectFingerprint(base, result, writeScope)` is the CID of this canonical
object:

```ts
interface EffectFingerprint {
  kind: "loom.effect-fingerprint";
  schema: 1;
  entries: Array<{
    ident: NodeIdent;
    operationKind: string;
    effectKinds: string[];
    beforeContent: Cid | null;
    afterContent: Cid | null;
    beforePath?: Path;
    afterPath?: Path;
  }>;
}
```

Entries are restricted to the resolved `writeScope` and sorted by NodeIdent
bytes, then operation kind. `effectKinds` is a sorted, duplicate-free set.
Path-changing effects include both paths. Unrelated paths and content outside
`writeScope` are excluded. This definition allows a Recipe to absorb unrelated
changes in the new base while still detecting a change to the authored
write/effect shape.

Because content CIDs are included, an authored Recipe that is intended to
transform newly introduced matching content SHOULD omit
`expectedEffectFingerprint` and express safe bounds with pinned invariants. The
fingerprint is the stricter option for transformations whose scoped writes must
remain byte-for-byte equivalent in shape.

### 3.4 Using `reapply` inside `merge`

```
merge(base, ours, theirs):
  perNid = classify(ΔO, ΔT, base)                      # §2.3
  result = base
  for nid, cls in perNid:
    switch cls:
      INDEPENDENT | COMMUTING: result = compose(result, ops(nid))
      RECOMPUTABLE:            # the recipe side is re-run against the OTHER side's result
        out = reapply(recipeSideTransform(nid), stateWithOtherSideApplied)
        if out is CleanReapply: result = graft(result, out, nid)
        else:                   result = textThreeWay(result, base, ours, theirs, nid)  # fallback
      CONFLICT:                result = textThreeWay(...) or emit Conflict(nid)
  return { baseState: base, candidateState: result, conflicts }
```

The RECOMPUTABLE branch is Loom's merge-specific advantage: when a codemod (`ours`) and a hand edit
(`theirs`) touch the same `nid`, Loom **re-runs the codemod over the hand-edited base** rather
than trying to reconcile two textual diffs — so the human's new code also gets transformed
(worked in §5). If the recompute is anything but `CleanReapply`, it degrades to the mandatory text
3-way. No magic, no data loss.

---

## 4. Interaction with shared admission — the re-approval rule

A `merge`/`reapply` result is a new Transform submitted to a Shared Line through
the admission protocol. Two rules make this safe:

### 4.1 Facts are re-derived, never inherited

The reconciliation Transform's `resultState` differs from both parents, so
detectors run over the new authoritative diff from `base` to `result`. A
`reapply` that (say) newly matches a `sensitive_path` or adds a dependency the original run
didn't will surface those facts at admission. Facts that are a pure function of
the recomputed content and pinned tools may be verified/blockable.

### 4.2 Reapply that changes `resultState` **invalidates prior human approvals**

This is the subtle correctness rule the independent review surfaced. A `human-approval`
attestation (core spec §14) is pinned to a Transform CID via the provenance subject-pin:
`subject[0].digest.sha256 == sha256(TransformCID)`. When `reapply` recomputes a new
`resultState`, it produces a **new Transform CID**, so:

```
onReapply(original, outcome):
  if outcome is CleanReapply and outcome.resultState != original.resultState:
     # the approved bytes no longer exist; the subject-pin of any prior human-approval is now stale
     invalidatePriorApprovals(original)                 # do NOT carry them to the recomputed Transform
     reRunReviewerRouting(recomputedTransform)          # requiredReviewers reset per policy
  # agent-run + deterministic-check attestations are re-issued for the reapply run regardless
```

Concretely: an approval of "rename `foo`→`foo(…,ctx)` across 40 cells" does **not** silently
apply to a reapply that also rewrote a teammate's newly-added `foo(y)` — the reviewer approved
a different result. Admission treats the recomputed Transform as unapproved and re-triggers the
`ReviewerRequirement`s. `Divergence` outcomes are always human-routed. This closes the
"stale approval re-attachment" gap and keeps "humans approve _this_ risk" literally true.

### 4.3 Determinism class gates blockability

Only pinned-Recipe `CleanReapply` results yield verified recompute evidence.
Environment-sensitive Recipes MAY be executed by a separate advisory tool, but
their candidates still use the ordinary text/conflict and reviewer path.
Nondeterministic Recipes never reach verified reapply.

---

## 5. Worked cases

Notation: `S0` base; `nid:a…` cells; a codemod recipe `R = renameFn: foo(x) → foo(x, ctx)`
(`engine:"codemod:jscodeshift"`, `determinismClass:"pinned"`, `writeScope` = all `.ts` cells,
`invariants:[{kind:"parses",lang:"ts"}]`).

### 5.1 Clean absorb (non-conflicting base edit)

`ours` = Transform `T_R` applying `R` across 40 cells (`resultState S_ours`). Meanwhile
`theirs` bumps a version string in `README.md` (`nid:readme`, disjoint from `writeScope`).
Classification: every `nid` **INDEPENDENT** (no overlap). `merge` composes both with no
recompute and no text 3-way. Result lands; facts re-derived (a `dependency`/doc fact for the
README edit), approvals evaluated per policy. Git would also merge this cleanly — no
advantage claimed, just no regression.

### 5.2 Recompute over a conflicting base edit (the actual win)

`ours` = `T_R`. `theirs` edits `callers/a.ts` (`nid:a`) to add a **new** call `foo(y)`.
`nid:a` ∈ `R.writeScope` and ∈ `theirs.touched` ⇒ classification **RECOMPUTABLE**.

- **Git**: textual merge may be clean or conflicting depending on the changed
  hunks, but the human's new `foo(y)` remains **untransformed** because the
  codemod already ran on the old base.
- **Loom**: `reapply(T_R, stateWithTheirsApplied)` re-runs `R` over the base that already
  contains `foo(y)`. The rule now also rewrites `foo(y) → foo(y, ctx)`. Determinism self-check
  passes; `{parses:ts}` holds ⇒ `CleanReapply`. Result: **all** calls transformed, including
  the new one; zero conflict. A new Transform `T_R'` uses the current target
  head as its history parent, records `derivedFrom:[T_R]`, and carries the
  recomputed `resultState`; per §4.2 any prior human approval of `T_R` does not carry —
  admission re-routes reviewers because the result changed.

### 5.3 Divergence (rule would mis-transform a hand edit)

Same as 5.2 but `theirs` hand-edited `nid:a` into `const foo = wrap(orig)` — applying `R`
now produces `wrap(orig)(…, ctx)`, which violates `invariant {kind:"no_new_effect"}` or the
`expectedEffectFingerprint`. `reapply` returns **`Divergence`** with a per-`nid` report
(base vs. expected vs. actual). The engine does **not** land it; it emits a typed
`Conflict{kind:"recompute-divergence", suggestedResolution: candidateCid}` for a human/agent
to adjudicate. Safety preserved: a surprising recompute becomes a review item, not a silent
merge.

### 5.4 Hard failure → text 3-way fallback

The authority cannot resolve the pinned `toolchain.engineDigest`, so `reapply`
returns `HardFailure("toolchain-mismatch")`. The engine falls back to
**diff3 text 3-way** over `nid:a`'s text facet. If diff3 is clean, it lands as a normal
Transform; if diff3 conflicts, a typed `Conflict{kind:"content"}` is raised for
a human. Loom's guarantee is no silent loss and conservative fallback, not that
it resolves every case another VCS resolves.

### 5.5 Stale-approval closed (§4.2 in action)

`T_R` was approved by `alice` (human-approval attestation pinned to `addr(T_R)`). Base
advances; `reapply` yields `T_R'` with a new CID and new `resultState`. `invalidatePriorApprovals(T_R)`
fires; `alice`'s approval is **not** attached to `T_R'`; admission shows the requirement unmet and
re-requests review. `alice` (or a delegate holding the Grant) approves `T_R'`, producing a
fresh human-approval pinned to `addr(T_R')`. The ledger leaf for the admission records exactly
this new attestation set (core spec §14.2), so an auditor sees that the recomputed result was
the one approved.

---

## 6. Concurrency on a hot Shared Line

Local Lines require no shared admission (core spec §9.3). Contention exists at admission to a hot
Shared Line, resolved by optimistic concurrency + reapply:

```
submit loop (client):
  loop:
    expected := currentHead(line)
    outcome  := reapply(myTransform, expected.resultState)      # advance MY change onto the live head
    if outcome is HardFailure or Divergence:
        mergeBase := deterministicLcaState(expected.headTransform, myTransform)
        merged := merge(base=mergeBase,
                        ours=expected.resultState,
                        theirs=resultStateOf(myTransform))
        if merged.conflicts: return ManualResolution(merged.conflicts)   # human/agent authors resolution
        candidateTransform := buildTransform({
            parents: [expected.headTransform, myTransform],
            baseState: merged.baseState,
            resultState: merged.candidateState
        })
    else:
        candidateTransform := buildTransform({
            parents: [expected.headTransform],
            baseState: expected.resultState,
            resultState: outcome.resultState,
            derivedFrom: [myTransform]
        })
    res := SubmitProposal({line,
                           headTransform: addr(candidateTransform),
                           expectedHead: expected.headTransform,
                           …})
    if res == RebaseRequired: continue                          # head moved again; recompute (cheap for pinned recipes)
    return res
```

- For pinned Recipes, a rebase iteration can be a cheap recompute. A finite set
  of contenders whose changes remain independent or cleanly reapplicable SHOULD
  converge without manual conflict resolution. Loom does not guarantee
  starvation freedom under an unbounded stream of higher-priority admissions.
- A single hot Shared Line still serializes admissions: there is one compare-and-swap
  winner per round. Loom inherits the monorepo merge-queue bottleneck and can
  mitigate it by sharding Shared Lines per service or package. Cross-Line
  atomicity is an open core-spec decision; sharding does not by itself solve
  dependent multi-Line changes.
- **Federated divergence** (two admitted heads on the same Line across authorities) is out of
  scope for the merge engine proper: it is detected by the witness consistency
  checks in core spec §15 and healed by a governed reconciliation Transform that runs through this same
  engine (`merge` with `parents:[H1,H2]`). Never silent.

---

## 7. Limits & brutal honesty

1. **The reapply win is bounded to mechanical transforms.** If the change is not
   expressible as a `pinned` Recipe, verified reapply does not trigger and
   content reconciliation uses the conservative text safety floor. Loom still
   retains native identity, Intent, capability, admission, and audit semantics,
   but it does not claim a semantic-merge advantage for free-form bytes.
2. **Hermetic execution is rare in the wild.** The determinism guarantees assume engines run
   with no network/clock/ambient FS and a pinned toolchain. Most real repos have
   non-hermetic build/codemod steps; every escape hatch (a rule that shells out, reads env,
   hits the network) MUST demote `pinned` to environment-sensitive or
   nondeterministic behavior and leave the verified reapply path. The
   engine is only as strong as the sandbox, and sandboxing arbitrary codemods is itself hard.
3. **False-clean is the residual risk, not data loss.** `writeScope` + run-twice + `parses`
   invariants catch gross errors, but a rule can still produce plausible-wrong output that
   passes cheap invariants. An effect fingerprint only pins the expected scoped
   writes, not program correctness. The honest posture: reapply reduces conflict toil,
   and its verified facts, invariants, and mandatory admission review of changed results bound the
   risk — but "the codemod is correct" is never proven, only checked. This
   follows the attested-not-proven rule in core spec §3.6.
4. **Per-language semantic tooling is a treadmill.** Node-granular conflict scoping and the
   `parses`/AST invariants need per-language grammars (tree-sitter/LSP). At v1 that is ~1
   language (TS/JS); the long tail is unbounded and unmaintained-by-default. Where no grammar
   exists, content reconciliation falls to the text safety floor. The semantic
   advantage is a per-language maintenance cost.
5. **A hot Line serializes head transitions** (§6). Checks and object transfer
   can run in parallel, but each Line has one ordered admitted history. Sharding
   reduces unrelated contention; batching and cross-Line atomicity require
   separate protocol rules.
6. **Merge novelty is not the whole native-VCS case.** Without pinned reapply,
   content reconciliation deliberately resembles LCA plus diff3. Loom's broader
   native model still changes the unit of work and trust boundary through stable
   identity, typed Transforms, delegated capabilities, atomic admission, and
   independently verifiable records. The merge-specific novelty remains
   identity-stable conflict scoping and governed recomputation.

## 8. Conformance test suite

```
# Safety floor (must always hold)
- conservative-parity-corpus: compare Loom with reference diff3 and Git over a
  published corpus; every difference is classified and reviewed. Loom MAY
  surface a conflict where Git is clean, but MUST NOT silently drop a change.
- no-silent-loss: property test — for random ΔO/ΔT over random DAGs, every input op is either
  present in the result or surfaced in a typed Conflict; nothing vanishes.
- fail-safe classification: `commute()` returning false must never lose a change (falls to 3-way).

# Conflict model
- move/edit-composition: move on one side plus content edit on the same NodeIdent
  composes when the destination is free and neither side deletes or divergently
  moves the Cell.
- node-granular scope: edits to different Cell identities are independent even
  when their paths are nearby. Sub-file independence requires verified semantic
  facets and is not assumed for file-granular Cells.

# Reapply engine
- clean-absorb (§5.1); recompute-win (§5.2) compared with reference text merge,
  with Loom required to transform the newly introduced matching call when the
  pinned Recipe and invariants permit it.
- divergence detection (§5.3): invariant/effect-fingerprint violation => Divergence, never lands.
- hard-failure fallback (§5.4): toolchain mismatch/precondition/scope-escape => text 3-way.
- determinism guard: a deliberately non-hermetic engine fails the run-twice self-check.
- writeScope enforcement: a rule writing outside writeScope => HardFailure.

# Governance correctness (the stress-test gap)
- stale-approval-invalidation (§4.2/§5.5): reapply changing resultState => prior human-approval
  NOT attached to the recomputed Transform; ReviewerRequirement re-triggered; ledger leaf
  records only the fresh approval set.
- fact-re-derivation: reapply that newly matches a sensitive_path/dependency surfaces the
  VerifiedFact at admission (not inherited from the parent).
- determinism-class gating: environment-sensitive and nondeterministic Recipes
  never produce a verified `CleanReapply`.

# Concurrency
- hot-line rebase loop (§6): a finite eligible contender set converges without
  manual resolution when every recompute remains `CleanReapply`; otherwise the
  contender produces a typed conflict or manual-resolution result.
- serialization: exactly one CAS winner per admission round; losers rebase/recompute.
```

## 9. Current implementation gaps

The current prototype is intentionally smaller than this specification:

- `reapply()` currently accepts an environment-sensitive Recipe; conformance
  requires the verified path to accept only `pinned` Recipes.
- `expectedResultDigest` currently compares a complete prototype State address;
  it must be replaced by the scoped `expectedEffectFingerprint` defined here.
- `mergeStates()` and `reapply()` are separate public operations; the normative
  RECOMPUTABLE branch has not yet been integrated into one merge coordinator.
- prototype Cells are file-granular text/bytes values, so sub-file semantic
  independence is not implemented;
- the dependency-free text merger needs independent differential testing,
  binary handling, newline/encoding rules, and fuzzing before conformance; and
- merge results are not yet connected to native Transform creation, Shared Line
  admission, durable storage, or approval invalidation.

These are implementation tasks, not permission to weaken the normative safety
rules.

## 10. Open questions (merge engine)

1. **Sandbox model for engines.** What is the hermetic execution boundary (WASM? a locked
   container? a language-VM)? This gates whether `pinned` is real for third-party codemods.
2. **Invariant expressiveness vs. cost.** How rich can `invariants` be before checking them
   is as expensive/undecidable as the merge itself? Fix a bounded, decidable invariant DSL.
3. **`commute()` precision.** The conservative predicate trades recall for safety; measure how
   often it needlessly falls to text 3-way on real agent workloads and whether per-op
   commutativity tables are worth the complexity.
4. **Divergence adjudication UX.** Is a recompute-divergence report genuinely more actionable
   to a human than a text conflict, or just different? If not, the reapply advantage shrinks to
   the clean-recompute case only.
5. **Grammar sourcing.** Who maintains the per-language AST grammars/invariants, and what is
   the graceful-degradation contract when a grammar is missing or drifts?

## 11. Bottom line

The merge/reapply engine has two central agent-native advantages:
identity-stable Cell conflict scoping and deterministic recomputation for the
mechanical pinned-Recipe segment with approval-correct re-review. Both sit on a
mandatory LCA plus text-three-way safety floor. Loom guarantees conservative
behavior and no silent loss; it does not guarantee that every Git-clean case is
Loom-clean or that a Recipe is semantically correct. The advantage is bounded
to transformations that can be made hermetic, scoped, and machine-checkable.
