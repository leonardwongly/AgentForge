# Loom — The Reapply / Merge Engine (hardest-gap deep dive)

> Companion to `loom-detailed-design.md` (expands §3.5 and the "Merge/concurrency" row of the
> §17 gap register). This is the single hardest gap: turning "rebase the intent, not the diff"
> from a slogan into an engine that is safe, deterministic where it claims to be, and honest
> where it isn't. Status: design proposal, not implemented.

## 0. Thesis (the honest frame — do not skip)

1. **The floor is text 3-way merge over LCA. It is mandatory and always available.**
   Everything in this document is an _optimization layered on top of that floor_, never a
   replacement for it. If any optimization is uncertain, the engine falls back to text 3-way
   and, failing that, to a typed human conflict. There is no path where the engine "loses" a
   change to a clever algorithm.
2. **`reapply` wins only for MECHANICAL, DETERMINISTIC transformations** — codemods,
   dependency bumps, migrations, security remediations, generated code. For creative/logic
   edits the "program" degrades to "the model emitted these bytes," i.e. a recorded diff, and
   the engine merges it with text 3-way like git.
3. **General semantic merge is unsolved and is NOT attempted on the blocking path.** No
   language-agnostic sound semantic merge exists; per-language AST merge (GumTree/Spork/
   Mergiraf-class) is enrichment only and can never _clear_ a blocking text fact (§3.3 of the
   main doc). We do not pretend otherwise.
4. **A merge/reapply result is itself a Transform and goes through governance (RATP).** The
   engine never silently lands anything; its output is admitted like any other change, with
   facts re-derived and approvals re-evaluated (§4 here).

## 1. Scope & vocabulary

| Term               | Meaning here                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `base`             | the LCA State of the two lineages being combined (merge-base; §2)                                       |
| `ours` / `theirs`  | the two head States (e.g. the Shared Line head vs. a proposal head)                                     |
| `Transform.recipe` | the executable transformation + pinned toolchain that makes a change _reapply-eligible_ (main doc §3.5) |
| `reapply`          | re-execute a recipe against a new base to _recompute_ the change, instead of re-projecting an old diff  |
| `merge`            | combine two lineages into one new State via a reconciliation Transform                                  |
| conflict           | a **typed, node-granular** disagreement the engine cannot resolve automatically (§2.3)                  |

The engine has two entry points: **`merge(base, ours, theirs)`** (combine two lineages) and
**`reapply(transform, newBase)`** (advance one recipe-bearing Transform onto a moved base).
`merge` uses `reapply` internally when one side is recipe-bearing (§3.4).

## 2. The conflict model

### 2.1 Baseline: git-class, conceded

Base-state selection is **LCA over the lineage DAG** (`packages/afom` walks parent edges;
identical algorithm to git `merge-base`). On the blocking path, content reconciliation is
**diff3 text 3-way** over the `bytes`/`text` facet of each Cell. This is deliberately
git-class and we do not claim novelty here — it is the safety floor (thesis §1).

### 2.2 What Loom adds over git's line model: node-granular, identity-stable scoping

Git conflicts are **line ranges in a file**; a rename resets the analysis (git guesses).
Loom scopes conflicts to **Cells by stable `NodeIdent`** (main doc §2.3), so:

- A change is `{ nid, facet, opKind, effect }`-typed, not "lines 40–52 of a path."
- **Moves are free of conflict:** if `ours` renamed `nid:X` (path A→B) and `theirs` edited
  `nid:X`'s content, that is **not** a conflict — the move and the content edit compose
  (apply the move, then the content edit to the same `nid`). Git frequently reports this as a
  rename/edit conflict; Loom does not, because identity is a stored fact.
- Conflict blast radius is the set of overlapping `nid`s, not whole files.

### 2.3 Classification: independent vs. dependent vs. conflicting

For two Transform-sets `ΔO` (ours) and `ΔT` (theirs) over `base`, per touched `nid`:

```
for nid in touched(ΔO) ∪ touched(ΔT):
  o := opsOn(ΔO, nid); t := opsOn(ΔT, nid)
  if o == ∅ or t == ∅:               classify INDEPENDENT   # only one side touched nid -> apply both
  elif commute(o, t):                classify COMMUTING      # e.g. move on one side, prop on other
  elif oneSideIsPureReapplyRecipe:   classify RECOMPUTABLE   # defer to reapply (§3) instead of merging diffs
  else:                              classify CONFLICT(nid)  # needs text 3-way, then human if diff3 conflicts
```

- **INDEPENDENT** ops (disjoint `nid`s) always compose; this is the CRDT-flavored win for the
  common fleet case (agents editing different services/files) — zero contention, no merge.
- **COMMUTING** ops on the same `nid` compose by a fixed, tested precedence
  (move → prop → content); `commute()` is a total, conservative predicate (returns `false`
  when unsure → falls through to CONFLICT → text 3-way; **fail-safe, never fail-open**).
- **RECOMPUTABLE**: at least one side is a recipe-bearing Transform whose input set overlaps
  `nid`; the engine prefers `reapply` (recompute the rule against the other side's result)
  over merging two diffs. This is the only place Loom beats git; §3 defines it precisely.
- **CONFLICT(nid)**: reconcile the Cell's text facet with diff3; if diff3 reports a textual
  conflict, emit a **typed human conflict** (§2.4) — never auto-pick.

### 2.4 Typed human conflict (what a reviewer actually sees)

```ts
interface Conflict {
  nid: NodeIdent;
  path: string; // current path from identIndex
  kind: "content" | "delete/edit" | "recompute-divergence";
  base: Cid;
  ours: Cid;
  theirs: Cid; // the three Cell contents
  textConflict?: { markers: string }; // diff3 <<<<<<< region, when kind=content
  effects: Effect[]; // declared effects touching this nid (for policy)
  suggestedResolution?: Cid; // from reapply Divergence report, if any
}
```

A merge with any unresolved `Conflict` cannot be admitted (RATP rejects; §4). Resolution is a
human- or agent-authored Transform over the conflicting `nid`s, which itself re-enters
admission.

---

## 3. The `reapply` engine

### 3.1 Inputs and the recipe/engine model

`reapply(t: Transform, newBase: State)` is defined **only** when `t.recipe` is present.

```ts
interface Recipe {
  engine: EngineId; // "dep-bump" | "codemod:jscodeshift" | "codemod:comby"
  //  | "sed-rule" | "migration:sql" | "formatter:prettier" | …
  determinismClass: "pinned" | "environment-sensitive" | "nondeterministic";
  toolchain: ToolchainLock; // { engineDigest: Cid; runtimeDigest: Cid; env: EnvPins }
  rule: Cid; // the transformation program (a Blob) — the actual codemod/rule
  inputSelector: NodeSelector[]; // cells the rule may read
  writeScope: NodeSelector[]; // cells the rule may write (enforced; a write outside = HardFailure)
  invariants?: Invariant[]; // machine-checkable post-conditions (see 3.3)
  expectedResultDigest?: { sha256 }; // optional pin of the authored output tree (for divergence)
}
```

**Engines** are pure, sandboxed transformers registered in `packages/stop`. An engine takes
`(rule, inputCells, env)` and returns `writeCells` or an error. Engines must be **hermetic**:
no network, no clock, no ambient filesystem — only the declared inputs and the pinned
toolchain. `determinismClass` records the honest truth about an engine+rule:

- `pinned` — hermetic and reproducible: same `(rule, inputs, toolchain)` ⇒ byte-identical
  output. **Only `pinned` recipes are eligible to _win_ a merge** (recompute instead of
  diff-merge). Examples: jscodeshift/comby codemods, `dep-bump`, deterministic formatters.
- `environment-sensitive` — depends on tool version/locale/OS; reproducible only under an
  identical `EnvPins`. Reapply is attempted but the result is treated as `attested`, not
  `verified` (cannot block; §3.7 of main doc).
- `nondeterministic` — LLM freeform, network, timestamps. **Never reapplied**; the Transform
  degrades to a recorded text diff and merges via text 3-way. This is the honest boundary.

### 3.2 The algorithm

```
reapply(t, newBase) -> ReapplyOutcome:
  if t.recipe is absent:                      return HardFailure("no-recipe")           # -> caller uses text 3-way
  if t.recipe.determinismClass == "nondeterministic": return HardFailure("nondeterministic")

  # 0. toolchain self-check (determinism guard)
  if resolveToolchain(t.recipe.toolchain) mismatches available: return HardFailure("toolchain_mismatch")

  # 1. preconditions: every inputSelector/writeScope nid still resolves in newBase
  inCells := resolveAll(t.recipe.inputSelector, newBase)
  if any unresolved:                          return HardFailure("precondition")        # target vanished -> text 3-way

  # 2. execute the rule hermetically against newBase (NOT against the old diff)
  writeCells := Engine[t.recipe.engine].run(t.recipe.rule, inCells, t.recipe.toolchain.env)
  if writeCells escapes writeScope:           return HardFailure("engine_error:scope")

  # 3. build candidate State and self-verify determinism (run twice; must match)
  candidate := applyWrites(newBase, writeCells)
  if run-twice digests differ:                return HardFailure("nondeterministic_engine")  # honesty guard

  # 4. invariant + expected-shape checks
  for inv in t.recipe.invariants: if not check(inv, candidate): return Divergence(expected=?, actual=candidate, report=mk(inv))
  if t.recipe.expectedResultDigest and shapeDigest(candidate) != expected:
        return Divergence(expected=t.resultState, actual=addr(candidate), report=diffReport(t.resultState, candidate, newBase))

  return CleanReapply(resultState = Fabric.put(candidate), recomputed = true)
```

Outcome semantics (from main doc §3.5, made precise):

- **`CleanReapply`** — the rule ran hermetically, stayed in `writeScope`, passed its
  determinism self-check and invariants. `resultState` is the _recomputed_ tree. Non-conflicting
  base edits inside `inputSelector` are absorbed automatically (the rule simply sees them).
- **`Divergence`** — the rule ran but the result violated an `invariant` or the
  `expectedResultDigest` shape (e.g. a human hand-edited a target Cell so the rule now
  transforms it into something outside the authored intent). Emits a `report` (base/expected/
  actual per `nid`) for human or agent adjudication. **Never auto-accepted.**
- **`HardFailure`** — no recipe, nondeterministic, toolchain mismatch, precondition gone, or
  scope violation. The caller falls back to **text 3-way** over LCA for the affected Cells.

### 3.3 Invariants (cheap machine checks that turn "clean" into "trustworthy")

The scariest failure is a **false clean**: the rule runs and produces plausible-but-wrong
bytes. Mitigations, in order of strength:

1. **`writeScope` enforcement** — a rule that writes outside its declared cells hard-fails.
2. **Run-twice determinism self-check** — catches a nominally-`pinned` engine that isn't.
3. **`expectedResultDigest`** — pins the _shape_ the author saw; a materially different
   recompute becomes `Divergence`, not silent success.
4. **`invariants`** — declarative post-conditions the engine can check on `candidate`, e.g.
   `{kind:"parses", lang:"ts"}`, `{kind:"no_new_effect", not:["adds_dependency"]}`,
   `{kind:"count_delta", selector:"call foo(", expect:">=0"}`, or `{kind:"recipe_check",
check: «a pinned verifier recipe»}`. Invariants are the bridge from "reapply is convenient"
   to "reapply is safe to auto-land under policy."

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
  return { candidate: result, conflicts }
```

The RECOMPUTABLE branch is the whole point: when a codemod (`ours`) and a hand edit
(`theirs`) touch the same `nid`, Loom **re-runs the codemod over the hand-edited base** rather
than trying to reconcile two textual diffs — so the human's new code also gets transformed
(worked in §5). If the recompute is anything but `CleanReapply`, it degrades to git-class text
3-way. No magic, no data loss.

---

## 4. Interaction with governance (RATP) — the re-approval rule

A `merge`/`reapply` result is a **new Transform** submitted to a Shared Line via RATP (main
doc §4). Two rules make this safe:

### 4.1 Facts are re-derived, never inherited

The reconciliation Transform's `resultState` differs from both parents, so detectors
(`packages/detectors`, rebuilt) run over the **new** `fabricDiffView(base, result)`. A
`reapply` that (say) newly matches a `sensitive_path` or adds a dependency the original run
didn't will surface those `VerifiedFact`s at admission. Facts are a pure function of the
recomputed content (§3.7 main doc), so they are `verified`/blockable.

### 4.2 Reapply that changes `resultState` **invalidates prior human approvals** (stress-test §18.4)

This is the subtle correctness rule the independent review surfaced. A `human-approval`
attestation (main doc §9.4) is pinned to a Transform CID via the provenance **subject-pin**
(§9.5): `subject[0].digest.sha256 == sha256(TransformCID)`. When `reapply` recomputes a new
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
a different result. RATP treats the recomputed Transform as unapproved and re-triggers the
`ReviewerRequirement`s. `Divergence` outcomes are always human-routed. This closes the
"stale approval re-attachment" gap and keeps "humans approve _this_ risk" literally true.

### 4.3 Determinism class gates blockability

Only `pinned`-recipe `CleanReapply` results yield `verified` facts that can auto-satisfy
policy without re-review of the transformation itself; `environment-sensitive` reapplies
produce `attested` (non-blocking) provenance and still require the normal reviewer path.
`nondeterministic` never reaches this path (text 3-way only).

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

- **git**: `callers/a.ts` changed on both sides → textual conflict; the human's `foo(y)` is
  left **untransformed** (the codemod already ran on the old base).
- **Loom**: `reapply(T_R, stateWithTheirsApplied)` re-runs `R` over the base that already
  contains `foo(y)`. The rule now also rewrites `foo(y) → foo(y, ctx)`. Determinism self-check
  passes; `{parses:ts}` holds ⇒ `CleanReapply`. Result: **all** calls transformed, including
  the new one; zero conflict. A new Transform `T_R'` (`parents:[T_R]`, recomputed
  `resultState`) is produced; per §4.2 any prior human approval of `T_R` does **not** carry —
  RATP re-routes reviewers because the result changed.

### 5.3 Divergence (rule would mis-transform a hand edit)

Same as 5.2 but `theirs` hand-edited `nid:a` into `const foo = wrap(orig)` — applying `R`
now produces `wrap(orig)(…, ctx)`, which violates `invariant {kind:"no_new_effect"}` or the
`expectedResultDigest` shape. `reapply` returns **`Divergence`** with a per-`nid` report
(base vs. expected vs. actual). The engine does **not** land it; it emits a typed
`Conflict{kind:"recompute-divergence", suggestedResolution: candidateCid}` for a human/agent
to adjudicate. Safety preserved: a surprising recompute becomes a review item, not a silent
merge.

### 5.4 Hard failure → text 3-way fallback

`theirs` upgraded the repo's TypeScript, so the pinned `toolchain.engineDigest` no longer
matches ⇒ `reapply` returns `HardFailure("toolchain_mismatch")`. The engine falls back to
**diff3 text 3-way** over `nid:a`'s text facet. If diff3 is clean, it lands as a normal
Transform (git-class, no advantage, no regression); if diff3 conflicts, a typed
`Conflict{kind:"content"}` is raised for a human. This is the guarantee that the engine can
never do _worse_ than git.

### 5.5 Stale-approval closed (§4.2 in action)

`T_R` was approved by `alice` (human-approval attestation pinned to `addr(T_R)`). Base
advances; `reapply` yields `T_R'` with a new CID and new `resultState`. `invalidatePriorApprovals(T_R)`
fires; `alice`'s approval is **not** attached to `T_R'`; RATP shows the requirement unmet and
re-requests review. `alice` (or a delegate holding the Grant) approves `T_R'`, producing a
fresh human-approval pinned to `addr(T_R')`. The ledger leaf for the admission records exactly
this new attestation set (main doc §9.5), so an auditor sees that the _recomputed_ result was
the one approved.

---

## 6. Concurrency on a hot Shared Line

Local Lines never conflict (main doc §4.1). Contention exists only at admission to a hot
Shared Line, resolved by optimistic concurrency + reapply:

```
submit loop (client):
  loop:
    expected := currentHead(line)
    outcome  := reapply(myTransform, expected.resultState)      # advance MY change onto the live head
    if outcome is HardFailure or Divergence:
        merged := merge(base=lca(expected, myTransform), ours=expected, theirs=myTransform)
        if merged.conflicts: return ManualResolution(merged.conflicts)   # human/agent authors resolution
        candidateHead := merged.candidate
    else:
        candidateHead := outcome.resultState
    res := RATP.SubmitProposal({line, headTransform: candidateHead, expectedLineHead: expected, …})
    if res == RebaseRequired: continue                          # head moved again; recompute (cheap for pinned recipes)
    return res
```

- For **`pinned` recipes**, each rebase iteration is a cheap recompute (no human), so a fleet
  of agents contending on one Line makes progress without manual merges — the property git
  merge-queues lack.
- A single hot Shared Line still **serializes** admissions (one CAS winner per round); Loom
  inherits git's monorepo merge-queue bottleneck and mitigates it only by **sharding Shared
  Lines** per service/package (main doc §4.1, App-H). Conceded, not solved.
- **Federated divergence** (two admitted heads on the same Line across authorities) is out of
  scope for the merge engine proper: it is detected by the witness consistency check (main doc
  §8.2) and healed by a governed `line.reconcile` Transform that runs _through_ this same
  engine (`merge` with `parents:[H1,H2]`). Never silent.

---

## 7. Limits & brutal honesty

1. **The win is bounded to mechanical transforms.** If the change isn't expressible as a
   `pinned` recipe, `reapply` never triggers and you have git's merge with extra bookkeeping.
   The addressable fraction is exactly "changes an agent can emit as a rule, not as freeform
   bytes" — real (migrations, codemods, dep/security remediation, generated code) but a
   _segment_, not all code. Do not let a demo on codemods imply general-merge superiority.
2. **Hermetic execution is rare in the wild.** The determinism guarantees assume engines run
   with no network/clock/ambient FS and a pinned toolchain. Most real repos have
   non-hermetic build/codemod steps; every escape hatch (a rule that shells out, reads env,
   hits the network) silently demotes `pinned` → `environment-sensitive` → text-3-way. The
   engine is only as strong as the sandbox, and sandboxing arbitrary codemods is itself hard.
3. **False-clean is the residual risk, not data loss.** `writeScope` + run-twice + `parses`
   invariants catch gross errors, but a rule can still produce plausible-wrong output that
   passes cheap invariants. `expectedResultDigest` only pins the _authored_ shape, which the
   whole point of reapply is to change. The honest posture: reapply reduces _conflict toil_,
   and its `verified` facts + invariants + mandatory RATP review of changed results bound the
   risk — but "the codemod is correct" is never proven, only checked. This is the same class
   of trust as "attested, not proven" (main doc constraint 1).
4. **Per-language semantic tooling is a treadmill.** Node-granular conflict scoping and the
   `parses`/AST invariants need per-language grammars (tree-sitter/LSP). At v1 that is ~1
   language (TS/JS); the long tail is unbounded and unmaintained-by-default. Where no grammar
   exists, everything falls to the text lane — i.e. git. The semantic advantage is a
   per-language capital expense, forever.
5. **Serialization bottleneck is inherited, not solved** (§6). A hot Shared Line serializes
   admissions exactly like a git merge-queue; sharding is the only lever.
6. **This is the hardest gap and it is where the "native VCS" claim is weakest.** Strip the
   `pinned`-recipe optimization and the merge engine _is_ git's (LCA + diff3), re-skinned with
   identity-stable scoping. The genuine, defensible novelty is narrow: (a) identity-stable,
   node-granular conflict scoping (moves don't conflict), and (b) `reapply` recompute for the
   mechanical segment with governance-correct re-approval. Everything else is git-class by
   design and by necessity.

## 8. Conformance test suite

```
# Safety floor (must always hold)
- never-worse-than-git: for a corpus of real merge scenarios, Loom's result set ⊇ git's
  resolvable set; every case git resolves cleanly, Loom resolves cleanly or better.
- no-silent-loss: property test — for random ΔO/ΔT over random DAGs, every input op is either
  present in the result or surfaced in a typed Conflict; nothing vanishes.
- fail-safe classification: `commute()` returning false must never lose a change (falls to 3-way).

# Conflict model
- move/edit-no-conflict: rename on one side + content edit on same nid on the other => COMPOSES,
  asserted against `git merge` which reports a rename/edit conflict.
- node-granular scope: overlapping edits to different nids in the same file => INDEPENDENT.

# Reapply engine
- clean-absorb (§5.1); recompute-win (§5.2) asserted vs real `git merge-file` (must show git
  conflict + untransformed foo(y), Loom clean + transformed).
- divergence detection (§5.3): invariant/expected-digest violation => Divergence, never lands.
- hard-failure fallback (§5.4): toolchain mismatch/precondition/scope-escape => text 3-way.
- determinism guard: a deliberately non-hermetic engine fails the run-twice self-check.
- writeScope enforcement: a rule writing outside writeScope => HardFailure.

# Governance correctness (the stress-test gap)
- stale-approval-invalidation (§4.2/§5.5): reapply changing resultState => prior human-approval
  NOT attached to the recomputed Transform; ReviewerRequirement re-triggered; ledger leaf
  records only the fresh approval set.
- fact-re-derivation: reapply that newly matches a sensitive_path/dependency surfaces the
  VerifiedFact at admission (not inherited from the parent).
- determinism-class gating: environment-sensitive reapply yields `attested` (non-blocking)
  provenance; nondeterministic never reaches reapply.

# Concurrency
- hot-line rebase loop (§6): N pinned-recipe agents contending converge with 0 manual merges.
- serialization: exactly one CAS winner per admission round; losers rebase/recompute.
```

## 9. Open questions (merge engine)

1. **Sandbox model for engines.** What is the hermetic execution boundary (WASM? a locked
   container? a language-VM)? This gates whether `pinned` is real for third-party codemods.
2. **Invariant expressiveness vs. cost.** How rich can `invariants` be before checking them
   is as expensive/undecidable as the merge itself? Fix a bounded, decidable invariant DSL.
3. **`commute()` precision.** The conservative predicate trades recall for safety; measure how
   often it needlessly falls to text 3-way on real agent workloads and whether per-op
   commutativity tables are worth the complexity.
4. **Divergence adjudication UX.** Is a recompute-divergence report genuinely more actionable
   to a human than a git conflict, or just different? If not, the reapply advantage shrinks to
   the clean-recompute case only.
5. **Grammar sourcing.** Who maintains the per-language AST grammars/invariants, and what is
   the graceful-degradation contract when a grammar is missing or drifts?

## 10. Bottom line

The merge/reapply engine is buildable and has two genuinely defensible advantages over git —
**identity-stable node-granular conflict scoping** (moves don't conflict) and **`reapply`
recompute for the mechanical, `pinned`-recipe segment** with governance-correct re-approval.
Both sit on a mandatory git-class safety floor (LCA + diff3) that guarantees the engine is
never worse than git and never loses a change. But the advantage is **bounded to mechanical
transforms, gated on hermetic execution and per-language tooling, and cannot prove
correctness** — only reduce conflict toil and bound risk with invariants + mandatory review.
Consistent with the program verdict: valuable for the codemod/migration/remediation segment,
not a general-merge breakthrough, and it ships on git (P3) long before any git-free substrate.
