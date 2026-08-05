# @agentforge/loom-cli

The `loom` CLI ties the current Loom prototype slices into a runnable end-to-end
demonstration on a real Git repository: Git refs → Loom `State`s (`loom-git-bridge`) → deterministic
governance decision (`loom-ratify`) → optional signed provenance
(`loom-provenance`) that anyone can independently verify.

## Commands

```text
loom ratify --repo <dir> --base <ref> --head <ref> --policy <file>
            [--sign [--out <file>] [--pubkey-out <file>] [--did <did>] [--policy-version <v>]]
            [--space <id>] [--line <ref>] [--proposal <id>] [--title <t>] [--author <login>]
loom verify --repo <dir> --base <ref> --head <ref> --env <file> --pubkey <file>
```

`ratify` exits non-zero when the decision is `block`, so it is CI-usable.
When `--sign` is used, evaluation and signing finish before any artifact is
written. The envelope and verification public key are then staged beside their
respective targets and committed as one rename-and-rollback operation; a
reported staging or commit failure preserves both previous artifacts and emits
no artifact-success message.

`verify` re-derives both the base and head `State` addresses from the repo and
confirms the signature, transition subject, and predicate inputs bind the signed
decision to exactly that base-to-result change.

## Run it (via tsx; the workspace runs TypeScript directly)

```bash
# against any git repo, comparing two refs under a policy file
pnpm exec tsx packages/loom-cli/src/index.ts \
  ratify --repo /path/to/repo --base HEAD~1 --head HEAD --policy policy.yaml --sign

pnpm exec tsx packages/loom-cli/src/index.ts \
  verify --repo /path/to/repo --base HEAD~1 --head HEAD \
  --env loom-attestation.json --pubkey loom-attestation.pub.pem
```

The attestation verifies only against the same base/head transition. Even when
two evaluations have an identical head State, an envelope signed for one base
is rejected for the other because the canonical transition subjects differ.

## Honest scope

Demonstration/local tool. It generates an ephemeral signing key with `--sign`
and therefore does not satisfy the native identity, key lifecycle, admission,
storage, or trust profiles in the Loom specification. The governance decision
is the existing deterministic engine; the CLI adds no blocking logic of its own.

```bash
pnpm --filter @agentforge/loom-cli test
```
