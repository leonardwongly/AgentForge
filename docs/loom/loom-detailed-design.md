# Loom VCS Core Specification

> Specification: `0.1.0-draft`
>
> Status: normative pre-1.0 draft
>
> Product: **Loom**
>
> Compatibility: wire and storage formats may change before `1.0`

This document specifies Loom, a native version-control system for software
development in which humans, agents, and automation are first-class actors.
It evolves the original Loom detailed design into the authoritative core
specification. Git interoperability is required for migration and ecosystem
compatibility, but Git and GitHub are not Loom's source of truth.

The specification index is [README.md](README.md). Merge behavior is refined by
[reapply-merge-engine.md](reapply-merge-engine.md), and required evidence is
defined by [validation-plan.md](validation-plan.md).

## 1. Normative language and status

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are normative as defined by RFC 2119 and RFC 8174.

The target model in this document is normative even where the current
TypeScript prototype is smaller. A prototype mismatch is an implementation gap,
not an implicit specification amendment.

Conformance profiles are:

| Profile           | Required behavior                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOM-CORE`       | Canonical objects, native States and Transforms, local Lines, working-copy materialization, merge/reapply safety, durable storage, recovery, and integrity verification |
| `LOOM-AUTHORITY`  | Shared Lines, actor verification, Grants, policy evaluation, atomic admission, audit records, and a tamper-evident ledger                                               |
| `LOOM-AGENT`      | Structured Intents, recipe execution, agent-run provenance, delegated agent capabilities, and effect declarations                                                       |
| `LOOM-WITNESSED`  | External checkpoint witnesses, consistency proofs, split-view detection, and offline verification bundles                                                               |
| `LOOM-GIT-BRIDGE` | Safe Git import, export, and mirror behavior without making Git canonical                                                                                               |

An implementation MUST state the exact profiles and specification version it
claims. It MUST NOT claim general Loom conformance based only on a subset of
prototype libraries.

## 2. Product vision

Loom replaces commit-and-merge workflows with intent-driven, independently
verifiable transformations. A change is not only a byte delta. It is a binding
among:

- a machine-readable Intent;
- the base State;
- typed operations and their declared effects;
- the resulting State;
- actor identity and delegated authority;
- deterministic checks and evidence;
- human decisions where policy requires them;
- provenance attestations; and
- an admitted position in shared history.

Loom is designed around these realities:

1. Many agents may work concurrently and continuously.
2. Agents need bounded authority rather than borrowed human credentials.
3. Mechanical transformations should be replayable when their base moves.
4. Free-form model output is nondeterministic and must degrade safely to bytes.
5. Humans need inspectable text, explicit risk, and approval of the exact result.
6. Version-control correctness is a durability and security problem before it is
   an automation problem.

## 3. Non-negotiable invariants

Every conforming implementation MUST preserve the following invariants.

### 3.1 No silent loss

Every input operation is either represented in the resulting State, proven
redundant by an explicit equivalence rule, or surfaced as a typed conflict. A
merge, reapply, synchronization, recovery, or garbage-collection operation MUST
NOT silently discard user or agent work.

### 3.2 Content-addressed integrity

Immutable objects are identified by a digest of their canonical bytes. Clients
MUST verify an object's address before using it. Invalid objects MUST be rejected
or quarantined and MUST NOT become reachable from a Line.

### 3.3 Byte-authoritative state

The byte representation is the executable source of truth. Semantic facets MAY
add structure, facts, or review assistance, but they MUST NOT clear or lower a
blocking fact derived from authoritative bytes. A semantic facet admitted as
verified MUST reconstruct the exact authoritative bytes.

### 3.4 Governed shared history

Local authoring MAY be ungoverned. A Shared Line advances only through the
admission protocol. Authorization, structural validation, policy evaluation,
evidence, and required approvals are part of that state transition rather than
an external status check.

### 3.5 Exact-result approval

Human approval is bound to an exact Transform and result State. Every newly
constructed merge or reapply Transform invalidates prior human approvals, even
when it reproduces an identical result State. The initial specification defines
no transferable approval predicate; therefore every new Transform requires
fresh evaluation and approval when policy requires it.

### 3.6 Attested, not proven

Provenance proves that a key signed a claim and that the claim is bound to
specific content. It does not by itself prove that an opaque model produced the
content, that the claim is truthful, or that the software is secure or correct.

### 3.7 Crash-safe acknowledgement

An authority MUST NOT acknowledge an admitted Line update until the objects,
admission record, ledger event, and new head are durable according to the
declared storage profile. Recovery MUST deterministically complete or roll back
an interrupted update without exposing a partially admitted head.

## 4. Scope and non-goals

The pre-1.0 specification covers:

- canonical encoding and addressing;
- native object, State, Transform, Intent, Recipe, and Line models;
- stable node identity and exact move tracking;
- local and shared history;
- working-copy materialization and change capture;
- text three-way merge, typed conflicts, and deterministic reapply;
- actor identity, delegation, capability Grants, and revocation;
- deterministic governance and atomic admission;
- DSSE/in-toto provenance;
- tamper-evident admission history and optional external witnesses;
- native replication and synchronization;
- storage durability, recovery, backup, and garbage collection;
- Git migration and interoperability; and
- conformance and security requirements.

The specification does not claim:

- that model authorship can be cryptographically proven from a hosted model;
- that semantic merge is sound for arbitrary programs;
- that passing policy means code is safe, correct, compliant, or vulnerability-free;
- that every operation is automatically mergeable;
- that a single authority with self-operated witnesses is host-independent;
- backward wire compatibility before `1.0`; or
- automatic migration of trust, provenance, or stable identity from historical
  Git commits where those facts never existed.

## 5. Terminology

| Term                | Meaning                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Space**           | A versioned project namespace, trust root, and collection of Lines                                    |
| **Blob**            | Immutable raw bytes or a chunk manifest                                                               |
| **Cell**            | A typed, stable-identity unit normally materialized as a file-like entry                              |
| **Weave**           | An immutable path tree mapping segments to Cells, sub-Weaves, or external references                  |
| **State**           | A complete immutable snapshot of a Space's materializable content                                     |
| **NodeIdent**       | Stable identity of a Cell across moves and content changes                                            |
| **Intent**          | Structured goal, acceptance criteria, constraints, and evidence expectations                          |
| **Operation**       | Typed mutation from a base State toward a result State                                                |
| **Transform**       | Content-addressed unit of change binding Intent, operations, effects, base, and result                |
| **Recipe**          | Pinned executable description of a mechanical transformation                                          |
| **Line**            | Named mutable reference to an admitted Transform and its result State                                 |
| **Local Line**      | Client-owned Line that does not require shared admission                                              |
| **Shared Line**     | Authority-controlled Line that advances only through admission                                        |
| **Proposal**        | Immutable request to admit a Transform set to a Shared Line                                           |
| **Grant**           | Signed, attenuating capability delegated to an actor                                                  |
| **AdmissionRecord** | Immutable decision record binding a proposal, policy result, evidence, approvals, and head transition |
| **RejectionRecord** | Immutable failed-admission record that binds reasons and evidence without advancing a Line            |
| **Ledger**          | Append-only commitment to admitted transitions and security events                                    |
| **Working copy**    | Filesystem projection of a State plus a journal of local changes                                      |

## 6. Canonical encoding and addressing

### 6.1 Codecs and hashes

Normative structured objects MUST use canonical DAG-CBOR. Raw byte chunks MUST
use the multicodec `raw` codec. Object addresses MUST use CIDv1, lowercase
base32 text form, and multihash.

The mandatory pre-1.0 hash is SHA-256. Implementations MUST route hashing through
an algorithm-agile interface but MUST NOT create non-SHA-256 normative objects
until a later specification defines negotiation and migration.

Canonical encoders MUST:

- produce one byte representation for one logical object;
- reject duplicate map keys;
- reject non-canonical integer and length encodings;
- reject unsupported floating-point values;
- preserve byte strings exactly;
- include an explicit schema version in every structured object; and
- reject an unsupported major schema version.

Unknown fields in a known schema version MUST be rejected unless that schema
explicitly marks an extension map. This prevents different implementations from
hashing or interpreting the same object differently.

### 6.2 Object verification

`put(cid, bytes)` MUST recompute the CID before making an object reachable.
`get(cid)` MUST return bytes whose digest matches the requested CID or fail with
`HashMismatch`. Receivers MUST enforce configured limits before allocating or
decompressing attacker-controlled content.

### 6.3 Address domain separation

Where an identifier is derived rather than a CID, Loom MUST use a versioned
domain-separation string. Implementations MUST NOT reuse a digest directly across
object addresses, node identities, signature messages, and cache keys.

## 7. Loom object model

The following TypeScript-like definitions are illustrative. The requirements in
the surrounding prose are authoritative; machine-readable canonical schemas
must be frozen and published before the Phase 0 exit gate can pass.

### 7.1 Blob and chunking

```ts
interface BlobManifest {
  kind: "loom.blob";
  schema: 1;
  size: bigint;
  chunks: Array<{ cid: Cid; size: number }>;
}
```

Small content MAY be stored as one raw object. Large content SHOULD use
content-defined chunking with a versioned parameter set. Chunk boundaries are a
storage optimization and MUST NOT change the logical byte stream. The manifest
MUST commit to total size, ordered chunks, and each chunk size.

### 7.2 Cell and facets

```ts
interface Cell {
  kind: "loom.cell";
  schema: 1;
  ident: NodeIdent;
  bytes: Cid;
  size: bigint;
  mediaType?: string;
  mode?: number;
  entryType: "regular" | "executable" | "symlink" | "opaque";
  facets?: Record<string, { content: Cid; projector: Cid }>;
}
```

`bytes` is REQUIRED and authoritative. A symlink's bytes are its link target;
materializers MUST treat that target as data until the symlink creation phase.
Semantic or structured facets are OPTIONAL. A verified facet MUST identify a
pinned projector and satisfy:

```text
project(projector, facet.content) == authoritative bytes
```

If equality cannot be reproduced, the facet MUST be rejected or treated as
unverified advisory metadata.

### 7.3 Paths and Weaves

A Loom path is an ordered sequence of byte-string segments. A segment MUST NOT
be empty and MUST NOT contain NUL or `/`. `.` and `..` are forbidden as complete
segments. The canonical model is case-sensitive and performs no Unicode
normalization.

```ts
interface Weave {
  kind: "loom.weave";
  schema: 1;
  entries: Array<{ segment: ByteString; value: WeaveEntry }>;
}

type WeaveEntry =
  | { type: "cell"; cid: Cid }
  | { type: "weave"; cid: Cid }
  | { type: "external"; target: Cid; mediaType: string };
```

`entries` is an array because DAG-CBOR map keys are strings, while Loom path
segments are arbitrary permitted bytes. Entries MUST be sorted
lexicographically by raw segment bytes and MUST NOT contain duplicate segments.

Display paths MAY use escaped UTF-8. Implementations MUST preserve original path
bytes. A materializer MUST fail before mutation if the destination filesystem
cannot represent two distinct Loom paths, including case-folding or Unicode
normalization collisions.

### 7.4 State

```ts
interface State {
  kind: "loom.state";
  schema: 1;
  space: SpaceId;
  root: Cid;
  identityIndex: Cid;
}
```

A State contains no wall-clock timestamp. Metadata that should not affect the
snapshot MUST live in an attestation or event object. `identityIndex` maps every
reachable `NodeIdent` to exactly one path. It is a deterministic acceleration
structure and MUST agree with the Weave; disagreement invalidates the State.

### 7.5 Stable node identity

The original design derived a NodeIdent from the creating Transform CID, which
is circular because the Transform contains the operation that introduces the
NodeIdent. This specification replaces that construction.

An authoring session MUST generate a cryptographically random 256-bit
`creationNonce`. A new Cell identity is:

```text
NodeIdent = multibase(
  sha2-256(
    "loom-node-v1" || canonical(space, authorDid, creationNonce, ordinal)
  )
)
```

The nonce and author are included in the Transform. `ordinal` is the zero-based
creation order within that Transform. An implementation MUST reject duplicate
NodeIdents in a State. A move preserves the NodeIdent and content; copying creates
a new NodeIdent unless an explicit alias object is introduced by a future spec.

### 7.6 Intent

```ts
interface Intent {
  kind: "loom.intent";
  schema: 1;
  title: string;
  goal?: string;
  criteria: IntentCriterion[];
  constraints?: Constraint[];
  labels?: string[];
}
```

Intent text is a claim, not an enforcement mechanism. Machine-enforceable
criteria MUST reference a pinned check, policy, or attestation predicate.

### 7.7 Recipe

```ts
interface Recipe {
  kind: "loom.recipe";
  schema: 1;
  engine: string;
  determinismClass: "pinned" | "environment-sensitive" | "nondeterministic";
  toolchain: {
    engineDigest: Cid;
    runtimeDigest: Cid;
    environment: Record<string, string>;
  };
  rule: Cid;
  inputSelector: NodeSelector[];
  writeScope: NodeSelector[];
  invariants: Invariant[];
  expectedEffectFingerprint?: Cid;
}
```

`expectedEffectFingerprint` commits to the expected writes or semantic effects,
not the entire result State. Pinning the entire State would make legitimate
reapply over an advanced base diverge because of unrelated changes.
The `toolchain` object and each selector list are explicit even when their maps
or arrays are empty; omitted ambient environment values cannot be part of a
`pinned` Recipe.

A Recipe makes its Transform eligible for verified reapply only when two fresh
hermetic executions over the Transform's original `baseState` return canonical
operation-array bytes exactly equal to each other **and** to
`Transform.operations`, and applying that exact list reproduces the Transform's
`resultState`. State equality alone is insufficient: alternate, reordered,
net-zero, or merely equivalent operation programs do not prove that every
authored operation, capability footprint, and implied effect was preserved.
This **authored-operation coverage check** accounts for the whole authored
program. If a Transform mixes manual operations with Recipe output that the
Recipe does not reproduce exactly, verified reapply MUST return
`HardFailure("recipe-coverage")`; the complete Transform then uses ordinary
merge/conflict handling. Clients SHOULD represent independently reappliable
mechanical and manual work as separate ordered Transforms.

### 7.8 Transform

```ts
interface Transform {
  kind: "loom.transform";
  schema: 1;
  space: SpaceId;
  parents: Cid[];
  baseState: Cid;
  resultState: Cid;
  intent: Cid;
  author: Did;
  creationNonce: ByteString;
  operations: Operation[];
  declaredEffects: Effect[];
  recipe?: Cid;
  derivedFrom?: Cid[];
}
```

The Transform MUST NOT contain its own signature or post-address provenance
attestations. Including those fields creates a content-addressing cycle: the
signature or attestation needs the Transform CID, while the CID would need the
signature or attestation bytes. Instead, signatures and attestations are
separate objects that subject-pin the completed Transform CID.

For a linear Transform, `parents` contains the current parent Transform and
`baseState` MUST equal that parent's result State. A reconciliation Transform
contains every reconciled head in `parents`, uses the selected LCA State as
`baseState`, and produces the merged `resultState`.

A reapply onto a new head MUST use that new head as its history parent and SHOULD
put the original Transform in `derivedFrom`. It MUST NOT claim the original
Transform as its sole history parent when its base is a different Line head.

For every Shared Line transition, the Proposal's `expectedHead` MUST be an
ancestor of `headTransform`, including the equality case only for a rejected
no-op. The **introduced Transform closure** is:

```text
ancestors(headTransform) - ancestors(expectedHead)
```

where ancestry includes the named Transform itself. The authority MUST traverse
all parent edges, reject cycles, missing objects, and configured traversal-limit
violations, and verify every Transform in that closure. Side history may enter
the closure only through a reconciliation Transform that names every reconciled
tip in `parents`, including the current `expectedHead`, and uses the specified
LCA and merge rules. Directly assigning an old or unrelated Transform as the new
head is forbidden. A rollback restores prior content with a newly authored
Transform descended from the current head so that its operations, effects,
authorization, and policy consequences remain visible.

`parents` and `derivedFrom` are canonical CID sets: sorted by CID bytes and
duplicate-free. `operations` is an ordered program and MUST retain its authored
order. `declaredEffects` is a canonical set under the effect registry's encoded
sort order.

### 7.9 Signatures, Proposals, admissions, and rejections

```ts
interface TransformSignature {
  kind: "loom.transform-signature";
  schema: 1;
  subject: Cid;
  signer: Did;
  keyId: string;
  signature: ByteString;
}

interface Proposal {
  kind: "loom.proposal";
  schema: 1;
  line: LineId;
  expectedHead: Cid;
  expectedSequence: bigint;
  headTransform: Cid;
  transformSignatures: Cid[];
  attestations: Cid[];
  grants: Cid[];
  idempotencyKey: string;
}

interface AdmissionRecord {
  kind: "loom.admission";
  schema: 1;
  proposal: Cid;
  line: LineId;
  previousHead: Cid;
  previousSequence: bigint;
  admittedHead: Cid;
  admittedSequence: bigint;
  decisionTime: string;
  resultState: Cid;
  policy: Cid;
  decision: "pass" | "warn" | "override";
  facts: Cid;
  evidence: Cid[];
  approvals: Cid[];
  attestations: Cid[];
  grants: Cid[];
}

interface RejectionRecord {
  kind: "loom.rejection";
  schema: 1;
  proposal: Cid;
  line: LineId;
  observedHead: Cid;
  observedSequence: bigint;
  decisionTime: string;
  policy: Cid;
  decision: "stale" | "invalid" | "unauthorized" | "conflict" | "block";
  reasons: RejectionReason[];
  facts: Cid | null;
  rebaseEvidence: Cid | null;
  evidence: Cid[];
  attestations: Cid[];
  grants: Cid[];
}

interface RebaseEvidenceBase {
  kind: "loom.rebase-evidence";
  schema: 1;
  candidateHead: Cid;
  observedHead: Cid;
}

type RebaseEvidence =
  | (RebaseEvidenceBase & {
      status: "available";
      selectedLca: Cid;
      bestAncestors: Cid[];
      unavailableReason: null;
    })
  | (RebaseEvidenceBase & {
      status: "unrelated";
      selectedLca: null;
      bestAncestors: [];
      unavailableReason: null;
    })
  | (RebaseEvidenceBase & {
      status: "unavailable";
      selectedLca: null;
      bestAncestors: [];
      unavailableReason: "candidate-unavailable" | "traversal-limit";
    });

interface RebaseRequiredBase {
  kind: "loom.rebase-required";
  schema: 1;
  line: LineId;
  expectedHead: Cid;
  expectedSequence: bigint;
  candidateHead: Cid;
  observedHead: Cid;
  observedSequence: bigint;
  evidence: Cid;
}

type RebaseRequired =
  | (RebaseRequiredBase & { scope: "shared"; rejection: Cid })
  | (RebaseRequiredBase & { scope: "local"; rejection: null });
```

For `TransformSignature`, the signed message is canonical DAG-CBOR encoding of
`["loom-transform-signature-v1", schema, space, subject]`, where `space` is
read from the subject Transform and `subject` is that Transform's CID. The
verification algorithm is selected by the resolved `keyId`; implementations
MUST reject an algorithm or key type that the declared DID method does not
authorize.

Every non-genesis Transform in the introduced closure MUST have at least one
valid TransformSignature whose `subject` is that Transform's CID and whose
`signer` equals `Transform.author`. The resolved `keyId` MUST be authorized for
that author at the admission ledger position. Additional co-signatures MAY be
recorded, but a signature by another actor does not authenticate the author and
cannot replace the required author signature. The leaf Grant audience used to
authorize the Transform MUST be the same author. Genesis authentication follows
the separately signed SpaceDescriptor rule in §9.1.

Proposal and AdmissionRecord arrays MUST be canonical sets: sorted by CID,
duplicate-free, and interpreted exactly. `Proposal.grants` is the union of all
submitted Grant objects; each chain is reconstructed from signed `parent` links,
not array order, so one Proposal can authorize multiple Transform authors and
approvers without treating unrelated Grants as one chain. The signature set MUST
cover every Transform in the introduced closure. An admission MUST bind the
complete sets used for the decision so evidence cannot be detached after the
fact. RejectionRecord evidence, attestation, and Grant arrays follow the same rule;
`reasons` uses a closed, versioned rejection-reason registry. `facts` is
explicitly `null` when facts were not derived; omission is not an alternate
encoding.

`RebaseEvidence` is a closed discriminated union; fields from another status are
invalid rather than ignored. In the `available` variant, `bestAncestors` is a
sorted, duplicate-free, non-empty complete best-ancestor set and `selectedLca`
is chosen by §9.4. The `unrelated` and `unavailable` variants have exactly the
empty ancestor tuple and null LCA; only `unavailable` carries a typed reason. The
candidate and observed heads are always explicit. A Shared stale rejection MUST
store the evidence CID in `RejectionRecord.rebaseEvidence`; non-stale rejections
MUST store null. The RebaseRequired projection and evidence objects are reachable
from the same atomic outcome. A Local response uses the same canonical evidence
and response schemas with `rejection:null` and stores both CIDs in idempotency
state. Every response field MUST equal its linked evidence/record field; a
mismatch invalidates the response.

## 8. Transform algebra

### 8.1 Operation vocabulary

The initial operation set is:

```ts
type Operation =
  | { op: "put_cell"; at: Path; ident: NodeIdent; cell: Cid }
  | { op: "delete_cell"; selector: NodeSelector }
  | { op: "move_cell"; selector: NodeSelector; to: Path }
  | { op: "set_metadata"; selector: NodeSelector; metadata: Cid }
  | { op: "patch_bytes"; selector: NodeSelector; range: [bigint, bigint]; content: Cid }
  | { op: "put_facet"; selector: NodeSelector; facet: string; content: Cid; projector: Cid }
  | { op: "delete_facet"; selector: NodeSelector; facet: string }
  | { op: "put_external"; at: Path; target: Cid; mediaType: string };
```

Every operation has explicit preconditions. An absent selector, occupied move
destination, invalid range, identity collision, facet projection mismatch, or
path violation MUST return a typed failure and MUST NOT become a silent no-op.

Authorization uses an operation's complete **capability footprint**, not only the
field typed as `NodeSelector`:

- `put_cell` and `put_external` include their destination `at` path;
- `delete_cell`, `set_metadata`, `patch_bytes`, `put_facet`, and `delete_facet`
  include the resolved source NodeIdent and current path; and
- `move_cell` includes the resolved source NodeIdent, its current path, and the
  destination `to` path independently.

A destination or creation path MUST be covered by a path selector; authority over
a NodeIdent at its current location does not grant authority to move or recreate
it in another namespace. Each Transform MUST be authorized by one valid Grant
chain whose leaf covers every operation name, every member of every operation's
capability footprint, aggregate effects, and resource bounds. Implementations
MUST NOT combine partial coverage from otherwise insufficient chains to
manufacture authority for one Transform.

Operations are applied in listed order. A verifier MUST apply them from
`baseState` and reproduce `resultState` exactly. An implementation MAY use an
optimized representation but MUST produce the same canonical result.

### 8.2 Effects

Effects are a closed, versioned vocabulary used by authorization and policy.
The first registry includes source edits/deletes, moves, dependency changes,
migrations, test deletion/skipping, assertion weakening, CI changes, sensitive
paths, secret-like values, and generated artifacts.

The declared effects MUST be a superset of effects implied by authoritative
operations and bytes. Under-declaration rejects the Transform. Over-declaration
MAY be accepted but MUST be visible to authorization and policy evaluation.

Effect inference MUST be deterministic for blocking use. Facts that depend on
network, clock, locale, unpinned tools, or model output are attestations and MUST
NOT independently create a verified blocking fact.

### 8.3 Semantic facets

Semantic operations are optional enrichment. Blocking decisions MUST be stable
when unverified semantic facets are removed. Verified semantic facts MAY add or
raise a finding but MUST NOT clear a byte-derived finding.

## 9. Lines and history

### 9.1 Space genesis

Space identity MUST NOT depend on the genesis Transform because the genesis
Transform itself contains the SpaceId. The initial controller generates a
random 256-bit `creationNonce` and derives:

```text
SpaceId = multibase(
  sha2-256(canonical(["loom-space-v1", initialController, creationNonce]))
)
```

```ts
interface SpaceDescriptor {
  kind: "loom.space";
  schema: 1;
  id: SpaceId;
  creationNonce: ByteString;
  initialController: Did;
  genesisState: Cid;
  genesisTransform: Cid;
  policyRoot: Cid;
}
```

Every Space has a genesis State and genesis Transform. The genesis Transform has
no parents, its base and result are the genesis State, and it performs no
operations. The descriptor commits to both genesis objects, the policy root,
and initial controller. Space creation MUST include a separate domain-separated
signature by the initial controller over canonical DAG-CBOR encoding of
`["loom-space-signature-v1", descriptorCid]`; bootstrap trust in that
controller is an explicit deployment input.

### 9.2 Line references

A Line is a mutable authority record:

```ts
interface LineRef {
  id: LineId;
  space: SpaceId;
  name: string;
  scope: "local" | "shared";
  creator: Did;
  creationNonce: ByteString;
  headTransform: Cid;
  headState: Cid;
  sequence: bigint;
  controller?: Did;
}
```

LineId is non-circular and independent of the mutable Line head:

```text
LineId = multibase(
  sha2-256(canonical(["loom-line-v1", space, creator, creationNonce]))
)
```

`creationNonce` is a random 256-bit value. `headState` MUST equal the result
State of `headTransform`. `sequence` increases by one for every committed head
transition; every Shared Line transition is an admitted transition. **Every
Local or Shared Line transition** MUST compare-and-swap the exact
`(headTransform, sequence)` tuple. A Shared Proposal supplies `expectedHead` and
`expectedSequence`; a Local seal supplies the tuple recorded by its
ChangeSession. A mismatch in either component returns `RebaseRequired` with the
observed tuple and MUST NOT overwrite the winner. This rule prevents concurrent
Local seals, stale Shared proposals, and `H → … → H` ABA requests from replacing
newer work.

### 9.3 Local and Shared Lines

Local Lines require structural validation but MAY omit shared policy and remote
coordination. Shared Lines MUST use admission. Promotion from local to shared is
a Proposal, not a raw pointer assignment. A Shared Line MUST name a controller;
a Local Line SHOULD name its owning actor as controller.

### 9.4 LCA and ancestry

Ancestry is defined by Transform parents. A best common ancestor is a common
ancestor for which no descendant is also a common ancestor of both heads. If
there is one best common ancestor, it is the LCA. If several exist, the initial
rule selects the lexicographically smallest CID and records the complete best
ancestor set in reconciliation evidence. Future recursive-merge behavior
requires a specification revision.

## 10. Working copies

A working copy is a projection and change-capture surface, never canonical
history.

### 10.1 Materialization

Before writing, a materializer MUST validate:

- every path and path collision;
- object integrity and total expansion size;
- file type and mode support;
- symlink targets and destination containment policy;
- available disk space where detectable; and
- that no untracked local path would be overwritten without explicit consent.

Materialization MUST use a crash-recoverable journal. Regular files MUST be
written to safe temporary paths and atomically renamed. Directories and regular
files MUST be established before symlinks. The materializer MUST NOT follow a
workspace symlink while writing another entry.

A failed checkout MUST leave either the previous complete projection or a
recoverable journal that deterministically resumes or rolls back. It MUST NOT
report success for a partial tree.

### 10.2 Change capture

Change capture MUST compare the working copy against its recorded base State. It
MUST distinguish tracked edits, moves, deletes, type changes, permission changes,
untracked paths, ignored paths, and path collisions. Rename inference from an
untracked filesystem is advisory until identity is established by an explicit
operation or journal record.

### 10.3 External tools

Compilers, tests, editors, and agents MAY operate on materialized files. Any tool
output promoted to a Transform MUST be captured as authoritative bytes and MUST
not depend on an unrecorded ambient path, environment value, clock, or network
response when the resulting Recipe claims `pinned` determinism.

### 10.4 Change sessions and agent isolation

A ChangeSession is a mutable local transaction journal, not an immutable Loom
object. It binds a random session identifier, actor, source Line, base Transform
and State, the source Line sequence observed at open, optional delegated Grant,
Intent draft, ordered operation journal, working-copy path, monotonically
increasing append sequence, and a digest of the journal prefix at each
acknowledged sequence.

Loom has no implicit repository-global staging index. Each concurrent human or
agent SHOULD receive a distinct ChangeSession and working copy. Implementations
MUST NOT capture files from one session into another merely because they share a
host filesystem. Selective capture is explicit by path or NodeIdent and records
the session that observed the bytes.

A seal request MUST bind the session's recorded Line tuple and an exact
`expectedAppendSequence` plus journal-prefix digest. Sealing MUST freeze that
journal prefix, read a stable working-copy snapshot, validate every operation
against the recorded base, store all reachable objects, construct the result
State, and create exactly one Transform. A changed Line tuple, appended journal
entry, digest mismatch, or file mutation returns a typed retry or
`RebaseRequired` rather than a mixed snapshot. Installing the Transform, updating
the Local Line by tuple CAS, and committing the seal idempotency result MUST be
one recoverable transaction; exactly one concurrent seal can win. The journal
MUST remain recoverable until that transaction is durable.

### 10.5 Reference authoring flow

The reference client flow is:

1. initialize a Space or explicitly import one from Git;
2. create or select a Local Line and open a ChangeSession from its current head;
3. attach an Intent and, for a mechanical change, a pinned Recipe;
4. let a bounded human or agent actor edit the isolated working copy;
5. inspect status, typed operations, effects, authoritative diff, and evidence;
6. seal the session into a Transform, issue its separate TransformSignature,
   and advance the Local Line;
7. propose the Transform head to a Shared Line;
8. rebase/reapply if the Shared Line moved, then re-run facts and approvals; and
9. receive an AdmissionRecord or RejectionRecord and synchronize the durable
   result.

Client command names are non-normative before `0.2`, but clients MUST expose the
distinction between local sealing and shared admission. They MUST NOT present a
locally created Transform as shared merely because its objects were uploaded.

## 11. Merge and reapply

The detailed algorithm is normative in
[reapply-merge-engine.md](reapply-merge-engine.md). The core requirements are:

1. Text three-way merge over a deterministic LCA is the mandatory safety floor.
2. Stable identity allows moves and edits to be composed without path guessing.
3. Automatic commutativity is conservative; uncertainty becomes text merge or a
   typed conflict.
4. Only a hermetic `pinned` Recipe that reproduces its complete authored result
   from the original base may produce a verified automatic reapply.
5. Environment-sensitive, partial-coverage, and nondeterministic recipes may
   produce advisory candidates but MUST NOT bypass the text/conflict and
   approval path.
6. Reapply executes against the new base, enforces write scope, re-derives facts,
   and creates a new Transform.
7. Every newly created merge or reapply Transform invalidates all previous human
   approvals, even when its result State equals a previously approved State.
8. A conflict MUST preserve base, sides, affected identity, and enough evidence
   for a human or agent to author an explicit resolution Transform.

## 12. Identity and capability Grants

### 12.1 Actor identity

Actors are humans, agents, or automation. Normative actor identifiers use DID
syntax. The initial implementation MAY support `did:key` and `did:web` while the
`did:loom` method is finalized. A deployment MUST publish the supported methods
and verification algorithms.

Transform signatures MUST use a versioned, domain-separated message that binds
the Transform CID and Space. Admission verifies the key that was valid at the
decision's ledger position, not merely the actor's latest key.

Key rotation and revocation MUST be ledgered. Compromise recovery MUST preserve
the ability to verify historical signatures while preventing revoked keys from
authorizing later admissions.

### 12.2 Grant model

A Grant delegates the product of:

```text
transform operations × governance actions × approval requirements
× path or NodeIdent selectors × effect bounds × caveats
```

```ts
type GovernanceAction = "approve" | "override";

interface GrantCaveat {
  registry: string;
  version: number;
  name: string;
  value: Cid;
}

interface Grant {
  kind: "loom.grant";
  schema: 1;
  space: SpaceId;
  line: LineId;
  ledgerOrigin: string;
  issuer: Did;
  audience: Did;
  keyId: string;
  transformOperations: Array<Operation["op"] | "*">;
  governanceActions: GovernanceAction[];
  approvalRequirements: Array<Cid | "*">;
  selectors: NodeSelector[];
  effectBounds: EffectBounds;
  caveats: GrantCaveat[];
  notBefore?: string;
  notAfter: string;
  notBeforeLedgerSequence?: bigint;
  notAfterLedgerSequence?: bigint;
  parent?: Cid;
  signature: ByteString;
}
```

`"*"` in `transformOperations` covers only Transform operation types; it does
not grant `approve` or `override`. An approval-only Grant can therefore use an
empty `transformOperations` list without granting write authority.

Every delegated child MUST be an attenuation of its parent. It MUST preserve the
exact `space`, `line`, and `ledgerOrigin`; version `0.1` defines no resource
wildcard. It cannot add a Transform operation or governance action, broaden an
approval requirement or selector, increase a cell budget, allow deletion or
sensitive access not allowed by the parent, extend either time or ledger-sequence
validity, or remove or alter a caveat. Undecidable inclusion MUST fail closed.

`caveats` is a canonical set sorted by encoded bytes and duplicate-free. The
initial profile uses a closed, versioned caveat registry. A child MUST include
every parent caveat byte-for-byte and MAY add recognized caveats; unsupported
registry/version/name combinations reject authorization rather than being
ignored. Caveat-specific handlers MAY define additional provably narrower forms,
but absent such a rule only exact retention is attenuation.

The root Grant MUST omit `parent` and have `issuer` equal to the Shared Line
controller. For every child, `parent` MUST equal the CID of the immediately
preceding Grant and `child.issuer` MUST equal `parent.audience`. The leaf
`audience` MUST equal the actor being authorized: the Transform author, approval
actor, or override actor. Missing parents, cycles, duplicate Grants, broken
issuer/audience continuity, and a mismatched leaf actor MUST fail closed.

The Grant signature covers canonical DAG-CBOR encoding of
`["loom-grant-signature-v1", unsignedGrant]`, where `unsignedGrant` is the
complete Grant map with only the `signature` field omitted. This binds every
field above, including `keyId`, resource scope, and caveats. The verification
algorithm and key type are selected by the issuer's resolved `keyId`; a method
that does not authorize that combination MUST be rejected. Grant timestamps
MUST be canonical RFC 3339 UTC instants with seconds precision; equivalent
alternate spellings are rejected rather than normalized.

For a Transform, one leaf Grant MUST cover every Transform operation, the
complete capability footprint defined in §8.1, aggregate effects, and resource
bounds. For a human approval, one leaf MUST include `approve`, cover the exact
approval-requirement CID (or an explicit `"*"`), and cover the affected selectors
and effects. An override requires `override` independently; `approve` does not
imply `override` and vice versa. The DSSE signing DID, predicate approver or
override actor, and leaf audience MUST be identical. An actor MUST NOT approve
its own Transform unless policy explicitly permits self-approval; the default
policy forbids it.

Every Grant signature MUST verify under the issuer key valid at the pending
admission ledger position, and every Grant MUST be unrevoked there. Time validity
is the half-open interval `notBefore <= decisionTime < notAfter`; absent
`notBefore` means no lower time bound, and `notAfter` is required. Ledger validity
uses the same half-open rule when present:
`notBeforeLedgerSequence <= event.sequence < notAfterLedgerSequence`; either
ledger bound MAY be absent. Every present upper bound MUST be greater than its
lower bound. A child lower bound cannot precede its parent's and a child upper
bound cannot exceed or remove its parent's. Equality with a lower bound is
valid; equality with an upper bound is expired.

Time bounds are evaluated against the single `decisionTime` committed in the
outcome record and LedgerEvent; ledger bounds use that event's origin-relative
sequence and therefore require `Grant.ledgerOrigin == LedgerEvent.origin`. Both
kinds of bound apply when present. An idempotent replay uses the original
committed position and time, never a newly sampled clock.

## 13. Governance and admission

### 13.1 Admission pipeline

Admission is an atomic state machine:

```text
receive Proposal from an authenticated replica
  → bind (replica, operation, idempotency key) to the Proposal CID
  → reserve the next ledger position and one monotonic decisionTime
  → compare expected (head, sequence)
  → fetch and verify all objects
  → derive the complete introduced Transform closure and verify required ancestry
  → verify every Transform's author signature and reproduce every result State
  → verify effects cover implied effects and compute complete capability footprints
  → authorize every Transform author through its controller-rooted Grant chain
  → derive deterministic facts from the complete authoritative Line transition
  → evaluate the pinned policy
  → validate evidence and approval/override actors, actions, requirements, and Grants
  → create AdmissionRecord or RejectionRecord
  → durably commit the outcome ledger event and, only for admission, the Line head transition
  → return the committed record
```

The authority MUST resolve `Proposal.line` to one LineRef and reject unless every
introduced Transform, every base/result State, and every traversed parent belongs
to exactly `LineRef.space`. Every author/approval/override Grant MUST name that
same Space and Line and the origin of the pending LedgerEvent. Cross-Space,
cross-Line, and cross-origin substitution is forbidden even when the same DID
controls both resources.

The authority MUST reject a Proposal when `expectedHead` is not an ancestor of
`headTransform`, when a reconciliation omits a reconciled tip, when any
introduced Transform is omitted from verification, or when the Proposal attempts
to assign an old head directly. Every introduced Transform and every parent edge
in the closure MUST be fetched, signature-checked, replayed, effect-checked, and
authorized. Policy facts MUST cover the authoritative transition from the
current Line State to the proposed result State as well as the per-Transform
operations, so a side branch or unrelated base cannot hide deletions or other
effects.

A RejectionRecord MUST bind the Proposal, Line, observed head and sequence,
decision time, policy, complete fact/evidence/attestation/Grant sets used for the
decision, and typed rejection reasons. It has no `admittedHead` and MUST NOT
cause a Line transition. A `warn`
decision MAY advance only when the policy explicitly permits it. A `block`
decision MUST NOT advance. An override requires a separate authorized human
attestation, a reason, and a policy rule permitting override.

Proposal idempotency is scoped by `(authenticatedReplica, "SubmitProposal",
idempotencyKey)`. The first committed outcome stores both the Proposal CID and
result. Replaying the same tuple with the same Proposal CID MUST return that
result; presenting a different Proposal CID under the tuple MUST fail with
`IdempotencyConflict` and MUST NOT return or replace the prior result.

A tuple mismatch MUST commit a `RejectionRecord{decision:"stale"}` and rejection
LedgerEvent atomically with that idempotency result while leaving the Line
unchanged. It MUST also commit the canonical RebaseEvidence and Shared
RebaseRequired objects, set `rebaseEvidence` to that evidence CID, and make all
three reachable. If the candidate head is unavailable because tuple comparison
precedes object fetch, evidence uses `status:"unavailable"`; the authority MUST
NOT fabricate an LCA. `RebaseRequired` is the transport projection of this
durable result. After response loss or restart, replay returns byte-identical
record, evidence, response, and observed tuple even if the Line has advanced
again; it MUST NOT recompute a newer result. `facts` is null, while evidence,
attestation, and Grant sets not evaluated on this early path are canonical empty
sets.

The authority samples `decisionTime` once per first-seen idempotency tuple. It is
a canonical RFC 3339 UTC instant with seconds precision, MUST equal the outcome
LedgerEvent's `recordedAt`, and MUST be no earlier than the previous event's
`recordedAt`. Clock rollback causes `ClockRollback` and a fail-closed write pause
rather than timestamp clamping. This time is authority-attested, not proof of
external wall-clock truth; witnesses MAY enforce a declared maximum receive-time
skew. Offline verification reproduces Grant checks from the committed time and
ledger sequence and reports the deployment's time trust model.

### 13.2 Deterministic facts

The fact-cache key MUST include all inputs capable of changing the result,
including base and result State CIDs, authoritative diff digest, detector suite
digest, toolchain digest, and policy version CID. A changed input invalidates the
cache. Only reproducible facts may be `verified` or `observed` for blocking.

### 13.3 Atomicity

The authority MUST make the following logically atomic:

- the admitted object reachability set;
- the AdmissionRecord;
- the ledger entry;
- the Line sequence and head; and
- the idempotency result.

The implementation MAY use a database transaction, write-ahead log, replicated
consensus log, or equivalent mechanism. After recovery, observers MUST see
either the old complete head or the new complete head with its record and ledger
entry. An acknowledged admission MUST never disappear under the declared
durability profile.

For a rejection, the RejectionRecord, ledger event, and idempotency result MUST
commit atomically while the Line head and sequence remain unchanged.

## 14. Provenance and approvals

### 14.1 Attestation format

Loom provenance uses DSSE envelopes containing in-toto Statement v1 subjects.
Every attestation MUST subject-pin the Transform CID and, when it describes a
result, MUST also include the result State CID. For a SHA-256 CIDv1 Transform,
the in-toto subject's `digest.sha256` value is the lowercase hexadecimal
multihash digest embedded in the validated CID, equivalently
`sha256(canonicalTransformBytes)`. It is NOT a new hash of the CID's textual or
binary representation. `subject.name` SHOULD contain the canonical CID text, and
verification MUST recompute the CID from the canonical Transform bytes before
accepting the embedded digest.

Initial predicates are:

- `loom.agent-run/v1` — actor, platform binding, model claim, prompt/context/tool
  digests, recipe, and run metadata;
- `loom.deterministic-check/v1` — exact inputs, checker identity and suite digest,
  facts digest, facts, policy, and decision;
- `loom.human-approval/v1` — exact Transform and State reviewed, requirement,
  evidence, decision, authentication method, and approver; and
- `loom.materialization/v1` — optional checkout/build/test environment and output
  digest evidence.

Raw prompts, transcripts, secrets, and source snippets SHOULD be stored by
digest with a redacted summary by default. Full retention requires explicit
policy, encryption, access control, and retention limits.

### 14.2 Non-circular binding

The binding chain is:

1. the Transform is canonically encoded and addressed;
2. signatures and attestations subject-pin that Transform CID;
3. the Proposal lists the submitted set;
4. the AdmissionRecord lists the exact accepted set; and
5. the ledger commits to the AdmissionRecord and head transition.

The Transform MUST NOT forward-reference those post-address objects. This
construction prevents detachment without introducing a hash cycle.

### 14.3 Approval invalidation

An approval is valid only when its signature, actor key, `approve` Grant action,
requirement scope, Transform CID, result State CID, affected selectors/effects,
and evidence set all verify at admission. The DSSE signer, predicate approver,
and leaf Grant audience MUST be the same DID. Overrides apply the equivalent
rule with the distinct `override` action and policy permission. A new Transform
CID or result State invalidates approval. Approval inheritance is forbidden in
version `0.1`.

## 15. Ledger and witnessed trust

Every `LOOM-AUTHORITY` implementation MUST maintain an append-only,
tamper-evident sequence of admissions, reconciliations, Grant changes, actor key
changes, proposal rejections, and security-relevant administrative actions.

```ts
interface LedgerEvent {
  kind: "loom.ledger-event";
  schema: 1;
  origin: string;
  sequence: bigint;
  eventType:
    "admission" | "rejection" | "grant-change" | "key-change" | "policy-change" | "administrative";
  subject: Cid;
  previous: Cid | null;
  recordedAt: string;
}

interface LedgerCheckpoint {
  kind: "loom.ledger-checkpoint";
  schema: 1;
  origin: string;
  treeSize: bigint;
  rootHash: ByteString;
  lastEvent: Cid | null;
}
```

`sequence` starts at zero and is gap-free. `previous` is `null` only for the
first event and otherwise contains the preceding LedgerEvent CID. An admission
event's subject is its AdmissionRecord; a rejection event's subject is its
RejectionRecord. Other event types subject-pin the immutable object describing
the change. `recordedAt` is canonical RFC 3339 UTC with seconds precision and is
non-decreasing within one origin. For admission and rejection events it MUST
equal the subject record's `decisionTime`. `lastEvent` is `null` only for an
empty checkpoint.

The normative Merkle construction follows RFC 6962 tree hashing with SHA-256:
each leaf is `SHA-256(0x00 || canonicalLedgerEventBytes)` and each interior node
is `SHA-256(0x01 || leftHash || rightHash)`. The empty-tree hash is
`SHA-256("")`. A checkpoint authority signature covers canonical DAG-CBOR
encoding of `["loom-checkpoint-signature-v1", checkpointCid]`. Witness
signatures cover `["loom-witness-signature-v1", checkpointCid]` and MUST use
keys from a separately configured trust domain. Implementations MUST provide
inclusion and consistency proofs.

Trust claims depend on deployment profile:

| Deployment                                 | Permitted claim                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| One authority, no external witness         | Integrity-checked and internally tamper-evident                            |
| One authority with independent witness     | Externally witnessed append-only history within the witness threat model   |
| Multiple authorities with quorum witnesses | Fork and split-view detection within the stated quorum and partition model |

An authority MUST NOT claim host independence merely because it operates
multiple witnesses under the same administrative control.

## 16. Replication and synchronization

The Loom Replication and Sync Protocol is transport-neutral at the semantic
layer. The first network binding SHOULD use HTTP/2 with streaming.

Required operations are:

```text
HasObjects(cids) -> missing cids
GetObjects(cids) -> verified object stream
PutObjects(stream) -> stored or rejected objects
GetLine(line, afterSequence?) -> head, sequence, and optional event stream
OpenChange(line, expectedHead, expectedLineSequence, baseState, idempotencyKey) -> session
AppendOperations(session, sequence, operations, idempotencyKey) -> acknowledged sequence and journal digest
SealChange(session, expectedHead, expectedLineSequence, expectedAppendSequence, journalDigest, intent, recipe?, idempotencyKey) -> Transform CID and new Line tuple
SubmitProposal(proposal) -> admission, rejection, or RebaseRequired
GetProof(admission or ledger position) -> verification bundle
```

Every non-object mutating request carries an idempotency key. Authorities scope
it by authenticated replica identity and operation name and atomically persist
the canonical request digest with the committed result. A replay with the same
digest MUST return the original result, including after response loss or session
closure. Reuse with a different digest MUST return `IdempotencyConflict` without
mutation. For `AppendOperations`, the stream sequence additionally deduplicates
frames and rejects gaps; it does not replace request idempotency. `SealChange`
binds the exact Local Line tuple, append sequence, and journal digest and commits
its Transform, Local Line CAS, and idempotency result atomically. `PutObjects` is
the explicit exception: CID plus verified bytes is its natural request identity,
and supplying different bytes for a CID is `HashMismatch`, never a new write.

Receivers MUST verify objects before promotion from quarantine, enforce object
count and byte quotas, bound concurrency, and reject decompression or expansion
bombs. A stale `SubmitProposal` uses `Proposal.headTransform` as `candidateHead`
and returns the durable RejectionRecord-backed `RebaseRequired` projection
defined in §13.1. A stale Local `OpenChange` or `SealChange` uses the request's
`expectedHead` as `candidateHead` because no new Transform has been committed;
its canonical request-bound response and evidence are stored with the
idempotency result. Replay returns that frozen result even if the Local Line
advances again. Neither path may act like an unleased force update or recompute a
different result on replay.

Offline clients MAY append to Local Lines. Reconnection syncs immutable objects
before submitting a Proposal. A client MUST retain unsynchronized reachable
objects until the authority acknowledges their durable admission or the user
explicitly abandons them.

## 17. Storage, durability, recovery, and garbage collection

### 17.1 Object writes

A local durable store SHOULD implement object writes as:

1. validate size and canonical form;
2. recompute and verify CID;
3. write to a non-reachable temporary object;
4. flush object data;
5. atomically install under the CID;
6. flush containing metadata where the platform requires it; and
7. only then publish a reference that can make the object reachable.

Equivalent transactional stores are permitted if they provide the same crash
semantics.

### 17.2 Recovery

On startup after an unclean shutdown, Loom MUST:

- validate or replay the transaction journal;
- remove or quarantine incomplete temporary objects;
- verify every Line head and referenced AdmissionRecord;
- detect a head/ledger mismatch;
- complete or roll back prepared admissions deterministically;
- preserve unsynchronized Local Lines; and
- expose degraded read-only recovery mode if integrity cannot be restored
  automatically.

Repair MUST never fabricate missing content. Missing reachable objects are data
loss and MUST be reported with their CIDs and affected roots.

### 17.3 Garbage collection

GC is mark-and-sweep over explicit roots. Roots include Space genesis, all Local
and Shared Line heads, open Proposals, retained AdmissionRecords, ledger
checkpoints, active working-copy bases, sync leases, pinned exports, and backup
leases.

Objects younger than the configured grace period MUST NOT be collected. GC MUST
use a snapshot or barrier so an object cannot become reachable after mark but
before sweep and then be deleted. Interrupted GC MUST be restartable. Deleting a
reachable object is a critical conformance failure.

### 17.4 Backup and restore

Backups MUST include objects, Line metadata, admission/idempotency state, ledger,
actor and Grant state, policies, and encryption metadata. Restore validation MUST
verify hashes, Line reachability, State reproduction samples, ledger consistency,
and key references before the restored authority accepts writes.

## 18. Security and privacy model

Loom assumes malicious or compromised agents, untrusted imported repositories,
malformed objects, stale clients, compromised credentials, curious operators,
and potentially dishonest authorities or witnesses.

Implementations MUST address:

- path traversal, symlink traversal, device files, and materialization collisions;
- object and decompression bombs;
- signature replay and cross-protocol signature confusion;
- key theft, rotation, revocation, and recovery;
- Grant amplification and undecidable selector matching;
- stale approval reuse;
- proposal replay and idempotency poisoning;
- time-of-check/time-of-use races in admission;
- Line-head rollback and split views;
- malicious recipes and sandbox escapes;
- secret leakage through objects, logs, diffs, provenance, and exports; and
- denial of service through hot Lines, deep DAGs, pathological merges, or proof
  generation.

Signing keys MUST NOT be stored as ordinary Loom objects. Recipe execution that
claims `pinned` determinism MUST run in a hermetic sandbox with no ambient
network, clock, filesystem, locale, or undeclared environment access.

Security-sensitive failures MUST be fail-closed at shared admission. Local tools
MAY offer explicit recovery overrides, but an override MUST create durable audit
evidence and MUST NOT silently convert corrupt data into valid history.

## 19. Git interoperability

Git is a bridge, not a dependency of the native model.

### 19.1 Import

Two modes are defined:

- **Snapshot import:** one Git tree becomes the Loom genesis State. Historical
  lineage and provenance are not invented.
- **DAG import:** commits become imported Transforms, parent relationships become
  Loom ancestry, and trees become States. Historical intent, actor identity,
  Recipes, approvals, and stable NodeIdents are marked unknown or imported,
  never presented as native facts.

Import MUST preserve file bytes, executable bits, symlink targets, and Gitlink
targets. It MUST report unsupported filters, sparse state, missing objects,
case-fold collisions, unsafe paths, and submodule limitations before cutover.

Git does not store stable file identity. Rename detection during import is
heuristic evidence and MUST NOT be represented as native verified identity
without explicit confirmation. Path-derived prototype identities are not
conformant native NodeIdents.

### 19.2 Export and mirroring

Export MUST materialize the exact authoritative bytes and supported modes of a
State. Every loss, omission, normalization, or unsupported object MUST be
reported. A mirror maps Loom admissions to Git commits, but the Git commit is a
projection; it is not the authoritative Loom Transform.

During a dual-safety pilot, every admitted State SHOULD be exportable to a
recoverable Git mirror. Mirror divergence MUST stop automatic cutover and
produce explicit evidence.

## 20. Current implementation status

The current executable packages prove important slices but do not yet satisfy a
native conformance profile.

Implemented and tested today:

- deterministic canonical JSON and SHA-256 prototype addresses;
- flat path-to-Cell States with text content;
- stable identity carried through moves;
- typed put/delete/move/patch operations and effect coverage checks;
- LCA, conservative merge classification, text three-way merge, and typed conflicts;
- two pure reapply engines, invariant checks, scope enforcement, and divergence;
- deterministic capability Grant attenuation and authorization;
- Git-ref import into prototype States;
- deterministic policy evaluation over Loom-derived text diffs;
- DSSE/in-toto deterministic-check attestations with subject pinning; and
- a repository-local `ratify` and `verify` CLI demonstration;
- a durable content-addressed object store and transactional Line journal
  (CAS on `(head, sequence)` with idempotency keys, crash-safe atomic writes,
  and cross-process file locking);
- canonical DAG-CBOR encoding/decoding and CIDv1 (SHA-256 multihash, lowercase
  base32) addressing with strict canonical validation;
- binary-safe chunked objects via the `raw`-codec BlobManifest pipeline
  (fixed and content-defined chunking, total-size commitment);
- `did:loom` actor identity and domain-separated NodeIdent derivation;
- a bounded invariant DSL and frozen, versioned effect-fingerprint schema;
- a hermetic Recipe sandbox with bounded resource accounting;
- deterministic encryption-at-rest for private objects (dedup-preserving); and
- a frozen Loom Wire v1 HTTP/2 binding with signed requests, replay protection,
  and a reference client/server transport (see [wire-protocol.md](wire-protocol.md)); and
- monorepo sharding (LineShard) with all-or-nothing cross-Line atomic proposals;
- working-copy materialization and change journal (with path-traversal safety);
- a Proposal/admission state machine with atomic cross-Line commit;
- persistent actor key lifecycle and Grant revocation;
- a tamper-evident admission ledger;
- object replication/synchronization and garbage collection;
- backup, restore, and fault-injection recovery;
- Git import fidelity (submodules, binary blobs, rename identity, `.gitattributes`)
  and streaming large-repo import;
- native policy facts derived from Transform effects;
- delegated agent sessions, effect capture, work graphs, and a Recipe SDK;
- native review/evidence routing; and
- witnessed trust with quorum, verification bundles, and fork detection.

Not yet implemented as a native system:

- a full Git export (Loom -> git) fidelity path (the import path is complete);
- native end-user and agent client applications beyond the CLI;
- the Phase 4 dual-safety pilot (an operational 30-day run, not code); and
- large-scale multi-authority reconciliation hardening.

## 21. Implementation roadmap and gates

The native Loom destination is a strategic decision. User research determines
sequencing and adoption, not whether Git remains the permanent substrate.

| Phase                                 | Deliverable                                                                                                    | Required exit evidence                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **0 — Specification** ✅                | Stable object semantics, threat model, conformance IDs, and decision register                                  | No unresolved circular identities; normative schemas reviewed; prototype gaps enumerated                                 |
| **1 — Native local kernel** ✅          | Object store, States, Transforms, Local Lines, working copy, merge/reapply, Git import/export, recovery and GC | Cross-process address determinism; fuzzed round trips; crash recovery; no silent loss; byte-exact materialization        |
| **2 — Shared authority** ✅             | Shared Lines, identities, Grants, native policy facts, atomic admission, ledger, backup/restore                | Unauthorized admission impossible in tests; CAS correctness; acknowledged writes survive faults; complete decision trail |
| **3 — Agent-native protocol** ✅        | Intent and Recipe SDK, delegated agent sessions, effect capture, work graphs, native review and evidence       | Multiple agents complete real concurrent work with traceable authority and bounded conflicts                             |
| **4 — Dual-safety pilot** ⏳            | Loom-authoritative project mirrored to Git with production-like operations                                     | At least 30 days; zero unrecoverable data loss; every admitted State exportable; restore drills pass                     |
| **5 — Witnessed and federated trust** ✅ | Independent witnesses, consistency proofs, multi-authority reconciliation                                      | Split-view detection under partition; quorum safety; offline verification; no undetected admitted fork in fault tests    |

No phase may trade away a prior phase's integrity, recovery, or authorization
requirements. Feature breadth is secondary to durability.

## 22. Performance objectives

Performance targets are gates only after correctness tests pass:

- local operation capture p95 under 20 ms for a warm small workspace;
- object existence query for 1,000 CIDs p95 under 30 ms on a local authority;
- cached working-copy status p95 under 200 ms for 100,000 paths;
- Shared Line admission p95 under 3 seconds excluding user review and long-running checks;
- Grant authorization depth up to 5 p95 under 5 ms;
- offline proof verification p95 under 10 ms for a one-million-entry ledger; and
- recovery time proportional to the incomplete journal, not total repository size.

Benchmarks MUST publish dataset, hardware, storage mode, cache state, object
sizes, concurrency, and percentile method. Unqualified benchmark claims are not
conformant evidence.

## 23. Decision register

### Resolved

1. **Loom is the product and native VCS is the destination.** Git is a migration
   and interoperability bridge.
2. **Authoritative bytes are mandatory.** Semantic facets are additive and
   fail-closed.
3. **Governance owns Shared Line admission.** It is not an external check.
4. **Transforms exclude post-address signatures and provenance.** Proposal,
   attestation, AdmissionRecord, and ledger objects bind them without a hash cycle.
5. **NodeIdent creation uses an authoring nonce, not the creating Transform CID.**
6. **Every new merge/reapply Transform requires fresh approval.** Approval is
   not inherited even when the new Transform reproduces an identical State.
7. **Only pinned hermetic Recipes may create verified automatic reapply results.**
8. **DAG-CBOR/CIDv1/SHA-256 is the pre-1.0 target encoding.** Hash agility is
   designed but not activated.
9. **Single-authority deployments claim tamper evidence, not host independence.**
10. **Durability and recovery gates precede ecosystem and convenience features.**
11. **SpaceId and LineId use nonce-based domain-separated derivation.** Neither
    depends on an object that embeds the derived identifier.
12. **Shared Line admission is ancestry-preserving.** The expected head must be
    an ancestor of the proposed head, and the complete introduced closure is
    verified; rollback is a new descendant Transform, never pointer reassignment.
13. **Identity and capability principals are continuous and least-privilege.**
    Author signatures, Grant hops, leaf audiences, exact Space/Line/ledger scope,
    Transform operations, governance actions, requirements, caveats, and complete
    footprints bind the same actor without write/approve/override implication.
14. **Recipe reapply is complete and atomic.** The Recipe must reproduce its
    original authored result, and its verified ordered operation set is
    integrated completely or not at all.
15. **Concurrency and replay identities are explicit.** Every Line update leases
    `(head, sequence)`; Local seals also lease the journal prefix; idempotency
    keys bind one request digest to one durable result, including stale rejection.
16. **in-toto SHA-256 subjects use the Transform object digest.** The digest is
    extracted from a verified CID multihash, not computed over the CID itself.
17. **Grant validity is ledger-verifiable.** Exact resource domains, half-open
    time/sequence bounds, one monotonic authority-attested decision time, and one
    ledger position are committed per outcome and reused for replay; external
    wall-clock truth depends on the declared witness/time trust model.
18. **Rebase outcomes are canonical and durable.** Shared stale outcomes bind a
    rejection, evidence, and response; Local stale responses use the same evidence
    schema, and idempotent replay never recomputes either.

### Open before `0.2`

1. ~~Select the first durable local object-store and Line-journal implementation.~~
   Implemented: `FileObjectStore` + `FileLineJournal` (CAS, idempotency,
   crash-safe atomic writes, cross-process `FileLock`).
2. ~~Freeze the canonical DAG-CBOR schemas and extension mechanism.~~ Implemented:
   `codec.ts` (canonical DAG-CBOR + CIDv1/SHA-256/base32) and `blob.ts`
   (BlobManifest chunking).
3. ~~Specify `did:loom` or formally limit `0.x` to existing DID methods.~~
   Implemented: `did.ts` (`did:loom` derivation, DID parsing, domain-separated
   NodeIdent).
4. ~~Select the hermetic Recipe sandbox and resource accounting model.~~
   Implemented: `sandbox.ts` (bounded recipe validation + engine budget).
5. ~~Define the bounded invariant DSL and freeze extension/versioning rules for
   the effect-fingerprint schema.~~ Implemented: `invariant-dsl.ts`.
6. ~~Freeze the HTTP/2 wire binding, authentication, and negotiation messages.~~
   Implemented: `wire.ts` + `wire-transport.ts` (see
   [wire-protocol.md](wire-protocol.md)).
7. ~~Define encryption-at-rest and optional private-object addressing without
   weakening deduplication or verification claims.~~ Implemented: `private.ts`
   (deterministic AES-256-GCM, dedup-preserving).
8. ~~Define large monorepo sharding and cross-Line atomic proposal semantics.~~
   Implemented: `proposal.ts` (LineShard model + all-or-nothing cross-Line
   prepare/commit under a global lock).

## 24. Conformance

The required test IDs, fault matrix, pilot evidence, and claim restrictions are
defined in [validation-plan.md](validation-plan.md). A release MUST publish:

- specification version and profiles;
- exact test results;
- unsupported requirements;
- storage and durability profile;
- trust and witness topology;
- migration limitations;
- security review status; and
- recovery drill evidence.

Passing unit tests for prototype libraries is valuable evidence but is not a
substitute for native durability, recovery, interoperability, and adversarial
conformance testing.
