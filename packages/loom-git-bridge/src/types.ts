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
  readonly type: "blob" | "tree" | "commit";
  /** Immutable object name. Optional only for compatibility with legacy readers. */
  readonly objectId?: string;
}

/** Port over git read operations (implemented by execGitReader, faked in tests). */
export interface GitReader {
  lsTree(ref: string): Promise<ReadonlyArray<GitTreeEntry>>;
  /** Read a blob by the immutable object ID returned by lsTree. */
  readBlob?(objectId: string): Promise<string>;
  /** Read raw blob bytes (for binary content); optional for legacy readers. */
  readBlobBytes?(objectId: string): Promise<Uint8Array>;
  /**
   * Legacy path-based read. stateFromGitRef uses this only when object-ID reads
   * are unavailable, preserving compatibility with existing in-memory readers.
   */
  readFile(ref: string, path: string): Promise<string>;
}

export interface TransformStates {
  readonly base: State;
  readonly result: State;
}
