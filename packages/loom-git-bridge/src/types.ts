/**
 * @agentforge/loom-git-bridge — type surface.
 *
 * The strangler seam: import a git ref pair into Loom {@link State}s so the Loom
 * governance/ratify path can run on a real repo (P2-on-git). Git I/O is behind
 * the {@link GitReader} port so the state-building logic is unit-testable with a
 * fake reader (no real repo required).
 *
 * Honest scope: git has no stable identity, so a Cell's NodeIdent is derived
 * deterministically from its path. A path change therefore reads as delete+add
 * (matching git's default), not a Loom rename, unless git itself reports it.
 */
import type { State } from "@agentforge/loom-core";

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree";
}

/** Port over git read operations (implemented by execGitReader, faked in tests). */
export interface GitReader {
  lsTree(ref: string): Promise<ReadonlyArray<GitTreeEntry>>;
  readFile(ref: string, path: string): Promise<string>;
}

export interface TransformStates {
  readonly base: State;
  readonly result: State;
}
