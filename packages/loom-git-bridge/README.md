# @agentforge/loom-git-bridge

The migration and interoperability seam: import a pair of Git refs into
prototype Loom `State`s so the governance/ratify path runs on a real repository.
Git is a bridge and test oracle, not Loom's normative source of truth.

## Surface

- `GitReader` — port over git reads (`lsTree`, `readFile`), so state-building is
  unit-testable with a fake (no real repo needed).
- `execGitReader(repoDir)` — real implementation over `git ls-tree` / `git show`
  via `node:child_process` `execFileSync` (argument array, **no shell**).
- `nodeIdentForPath(path)` — deterministic `NodeIdent` from a path.
- `stateFromGitRef(reader, ref)` / `transformSetFromGit(reader, base, head)`.

## Honest scope

Git has no stable node identity, so a Cell's `NodeIdent` is derived from its
**path**. A path change therefore reads as delete+add (matching git's default),
**not** a Loom rename, unless git itself reports the rename. The bytes/mode lane
is minimal; the authoritative TEXT lane is what the governance detectors consume.

```bash
pnpm --filter @agentforge/loom-git-bridge test
```
