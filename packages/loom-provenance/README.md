# @agentforge/loom-provenance

Signed provenance for Loom changes, assembled from **established standards**
(in-toto Statement v1 + DSSE envelope + Ed25519 via `node:crypto`) rather than
reinvented crypto. It binds a deterministic governance decision to a specific
change via the in-toto **subject digest** (the "subject-pin").

## Surface

- `generateKeyPair()` — Ed25519 key pair as PEM strings.
- `pae(payloadType, payload)` — DSSE Pre-Authentication Encoding.
- `factsDigest(facts)` — `sha256Hex(canonicalize(facts))`; re-derivable by anyone.
- `buildDeterministicCheckStatement(input)` — an in-toto Statement whose subject
  digest is pinned to the change's `Cid` and whose predicate records the checker,
  pinned inputs, facts, `factsDigest`, and the `pass|warn|block` decision.
- `signStatement(statement, key)` / `verifyEnvelope(envelope, publicKeyPem)`.
- `verifyProvenance({ transformCid, envelope, publicKeyPem })` — verifies the
  signature **and** that the subject-pin matches `transformCid` (fails with a
  precise reason otherwise).

## Honest scope

Produces and verifies signed, subject-pinned attestations. It does **not**
integrate a transparency log / Rekor / witness network (networked, kill-gated).
Per the design: **attested, not proven** — a valid signature proves _who signed
what_, not that the underlying claim is true.

```bash
pnpm --filter @agentforge/loom-provenance test
```
