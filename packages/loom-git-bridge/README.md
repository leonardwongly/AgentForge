# @agentforge/loom-git-bridge

The **strangler seam**: import a pair of git refs into Loom `State`s so the Loom
governance/ratify path runs on a **real repo** (P2-on-git), without going
git-free.

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
