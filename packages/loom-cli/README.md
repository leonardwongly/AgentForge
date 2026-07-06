# @agentforge/loom-cli

The `loom` CLI ties the Loom slices into a runnable end-to-end demo **on a real
git repo**: git refs → Loom `State`s (`loom-git-bridge`) → deterministic
governance decision (`loom-ratify`) → optional signed provenance
(`loom-provenance`) that anyone can independently verify.

## Commands

```text
loom ratify --repo <dir> --base <ref> --head <ref> --policy <file>
            [--sign [--out <file>] [--pubkey-out <file>] [--did <did>] [--policy-version <v>]]
            [--space <id>] [--line <ref>] [--proposal <id>] [--title <t>] [--author <login>]
loom verify --repo <dir> --head <ref> --env <file> --pubkey <file>
```

`ratify` exits non-zero when the decision is `block`, so it is CI-usable.
`verify` re-derives the head `State` address from the repo and confirms the
signature **and** subject-pin bind the signed decision to exactly that change.

## Run it (via tsx; the workspace runs TypeScript directly)

```bash
# against any git repo, comparing two refs under a policy file
pnpm exec tsx packages/loom-cli/src/index.ts \
  ratify --repo /path/to/repo --base HEAD~1 --head HEAD --policy policy.yaml --sign

pnpm exec tsx packages/loom-cli/src/index.ts \
  verify --repo /path/to/repo --head HEAD --env loom-attestation.json --pubkey loom-attestation.pub.pem
```

Verified end-to-end against a real two-commit repo: a `src/billing/**` change
is **blocked** (required reviewer pending); once signed, the attestation
**verifies** against the same head and is **rejected** (`subject digest does not
match transform`) against a different head.

## Honest scope

Demonstration/local tool. It generates an ephemeral signing key with `--sign`
(no key management / KMS / transparency log — those are out of scope). The
governance decision is the existing deterministic engine; the CLI adds no
blocking logic of its own.

```bash
pnpm --filter @agentforge/loom-cli test
```
