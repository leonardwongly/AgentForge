# @agentforge/loom-provenance

Signed provenance for Loom changes, assembled from **established standards**
(in-toto Statement v1 + DSSE envelope + Ed25519 via `node:crypto`) rather than
reinvented crypto. It binds a deterministic governance decision to a specific
base-to-result transition via the in-toto **subject digest** (the "subject-pin").

## Surface

- `generateKeyPair()` — Ed25519 key pair as PEM strings.
- `pae(payloadType, payload)` — DSSE Pre-Authentication Encoding.
- `factsDigest(facts)` — `sha256Hex(canonicalize(facts))`; re-derivable by anyone.
- `transitionSubjectCid({ baseState, resultState })` — a domain-separated,
  canonical content address for the ordered State transition.
- `buildDeterministicCheckStatement(input)` — an in-toto Statement whose subject
  is derived from `baseState` and `resultState` and whose predicate records the
  same pinned inputs, checker, facts, `factsDigest`, and decision.
- `signStatement(statement, key)` / `verifyEnvelope(envelope, publicKeyPem)`.
- `verifyProvenance({ baseState, resultState, envelope, publicKeyPem })` — verifies
  the signature, exact transition subject, matching predicate inputs, and facts
  digest (failing closed with a precise reason otherwise).

## Honest scope

Produces and verifies signed, subject-pinned attestations. It does **not** yet
integrate persistent actor keys, an admission record, transparency ledger, or
independent witness network; those remain required native implementation work.
Per the design: **attested, not proven** — a valid signature proves _who signed
what_, not that the underlying claim is true.

```bash
pnpm --filter @agentforge/loom-provenance test
```
