# Loom — Design-Partner & Willingness-to-Pay Validation Plan

> Companion to `loom-detailed-design.md`. This is the gate the independent
> stress-test said comes **before** further substrate investment: prove someone
> will pay for the delta over "git + Sigstore + a governance bot" — otherwise the
> P3+ build is uninvestable and the program stops here (a legitimate outcome).

## 0. Why this doc exists (the corrected G0)

The design's original G0 ("signed detector output reproducible across two
runners") is **tautological** — detectors are pure functions over
content-addressed inputs, so it can never fail. It tests "is a pure function
deterministic," not "will anyone pay." This plan replaces it with a **demand
gate** placed in front of the build.

**Corrected G0 (money, not math):** before any further custom substrate work,
secure ≥1 design partner who will **pay** (LOI, paid pilot, or committed budget)
for cryptographically-verifiable, agent-authored change-control that
git + Sigstore + branch-protection + a governance bot does **not** already give
them. If none, freeze at the current shipped state (`loom-core` + `loom-ratify`

- provenance) and do not build the networked substrate.

## 1. What is already shippable (the thing to sell)

- `@agentforge/loom-core` — deterministic object/change model + merge/reapply.
- `@agentforge/loom-ratify` — the existing governance engine, re-homed onto
  Loom Transforms (deterministic decides; humans approve risk).
- `@agentforge/loom-provenance` — signed `deterministic-check` attestations
  (in-toto/DSSE + Ed25519) binding facts + decision to a change.
- `loom` CLI + git-bridge — run the whole flow on a **real git repo** today.

This is the **P2 product on git**. The pitch is not "a new VCS"; it is
"tamper-evident, agent-aware change governance you can run on your existing repo."

## 2. The honest delta vs. "git + Sigstore + a governance bot"

| Capability                                         | git + Sigstore + bot             | Loom (P2)                                        | Real delta?                                                               |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Signed commits / attestations                      | ✅ (gitsign/cosign)              | ✅ (DSSE/in-toto)                                | No — parity                                                               |
| Deterministic policy decision recorded             | bot output (mutable)             | signed `deterministic-check` bound to the change | **Some** — the _decision_ is attested + reproducible, not just the commit |
| Facts re-derivable by anyone                       | ✗ (bot re-run, unpinned)         | ✅ (`factCacheKey` over pinned inputs)           | **Yes** — third-party re-derivation                                       |
| Intent + transformation as the unit                | ✗ (diff only)                    | ✅ (Transform + recipe + `reapply`)              | **Yes, but** only for mechanical changes                                  |
| Unbypassable (structurally can't merge without it) | ✗ (bot is advisory/side-channel) | **only if** admission owns the write path (P3+)  | **Not yet** at P2                                                         |
| Host-independent trust                             | ✗ (trust the forge)              | **only** federated + witnessed (P4/P5)           | **Not yet** at P2                                                         |

Blunt reading: at **P2 the delta is narrow** — attested + reproducible _decisions_
and intent/transform provenance. The big differentiators (unbypassable,
host-independent) need the kill-gated substrate. So the validation question is
whether the _narrow_ delta alone is worth paying for.

## 3. Target design partners (where the narrow delta is worth most)

Rank prospects by how much they feel the pain the narrow delta addresses:

1. **Regulated / audited orgs running agent fleets** (fintech, healthcare,
   gov-adjacent) that must _prove to an auditor_ who/what changed code and that
   the control actually ran — a mutable bot log is a finding; a signed,
   reproducible decision is evidence.
2. **Platform/DevEx teams governing autonomous agent PRs at volume** who already
   distrust "the bot said ok" and want a verifiable trail.
3. **Vendors shipping agent-generated code to customers** who need to attest
   provenance of machine-authored changes contractually.

Explicitly **not** the ICP yet: teams happy with CODEOWNERS + a status check and
no audit/contractual pressure. They will not pay.

## 4. Validation method (4–6 weeks, no further substrate build)

1. **Problem interviews (8–12):** confirm the pain is "proving the control ran /
   who authored," not generic code review. Kill signal: they only want better
   review UX (git tools already do that).
2. **Demo the shipped P2** on the partner's real repo via the `loom` CLI: run
   `loom ratify` on a recent agent PR, show the `PolicyResult` + the signed,
   independently-`loom verify`-able attestation. Measure reaction to the
   _verifiable decision_, not the governance (they have governance).
3. **Willingness-to-pay probe:** ask for a paid pilot / LOI / budget line for the
   verifiable-provenance capability specifically. Price against audit-cost
   savings, not seats.
4. **Falsification:** explicitly offer "would git-commit-signing + your existing
   bot + a spreadsheet do this?" If yes for ≥ most prospects, the delta is not
   worth a substrate — **stop.**

## 5. Success / kill criteria

- **PROCEED to P3 (substrate) only if:** ≥1 partner commits budget for the
  verifiable/unbypassable capability **and** names a requirement git+Sigstore+bot
  provably cannot meet (unbypassable admission or host-independent trust).
- **STAY at P2 (ship as a governance+provenance layer) if:** interest exists but
  only for the on-git attested layer — sell that, don't build the substrate.
- **STOP / shelve if:** no willingness-to-pay above the free git+Sigstore+bot
  baseline after ~12 conversations. This is a real and acceptable outcome; the
  shipped libraries remain useful internally.

## 6. What we are NOT doing during validation

No ledger/witness network, no RSP, no DID/PKI federation, no semantic AST lane,
no git-free substrate. Those are gated behind a _paying_ answer to §5, per the
detailed design's kill-gates.
