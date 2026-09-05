/**
 * @agentforge/loom-core — cross-process file lock (Phase 0, spec §23 item 1/15).
 *
 * The durable store's Line journal needs cross-process serialization so two
 * processes cannot advance the same Line concurrently. This is a small,
 * dependency-free advisory lock built on an exclusive-create lock file with
 * stale-lock recovery: a lock whose file is older than `staleMs` is considered
 * abandoned (the holder crashed) and is stolen.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import { randomUUID } from "node:crypto";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 25;

export class FileLock {
  private readonly lockPath: string;

  constructor(
    root: string,
    name: string,
    private readonly staleMs = DEFAULT_STALE_MS,
    private readonly acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS
  ) {
    const dir = join(root, "locks");
    mkdirSync(dir, { recursive: true });
    this.lockPath = join(dir, `${encodeURIComponent(name)}.lock`);
  }

  /**
   * Acquire the lock, returning a release function. Blocks (with a bounded
   * timeout) until acquired or until the timeout elapses.
   */
  async acquire(): Promise<() => void> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    for (;;) {
      try {
        const token = randomUUID();
        writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, token }), {
          encoding: "utf8",
          flag: "wx"
        });
        return () => this.release(token);
      } catch (error) {
        if (!isEexist(error)) {
          throw error;
        }
        if (this.stealIfStale()) {
          // The previous holder crashed; retry the exclusive create.
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`loom: timed out acquiring lock ${this.lockPath}`);
        }
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  }

  /** Synchronous variant for synchronous append/registry APIs. */
  acquireSync(): () => void {
    const deadline = Date.now() + this.acquireTimeoutMs;
    while (true) {
      try {
        const token = randomUUID();
        writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, token }), {
          encoding: "utf8",
          flag: "wx"
        });
        return () => this.release(token);
      } catch (error) {
        if (!isEexist(error)) {
          throw error;
        }
        if (this.stealIfStale()) {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`loom: timed out acquiring lock ${this.lockPath}`);
        }
        // A synchronous API cannot await; sleep without a busy CPU loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_INTERVAL_MS);
      }
    }
  }

  private isStale(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs > this.staleMs;
    } catch {
      // Lock disappeared between check and stat.
      return true;
    }
  }

  /**
   * Atomically retire an abandoned lock. Returns false when the lock is live
   * or another contender won the steal race, so a contender can never delete
   * a lock freshly created between checking staleness and stealing it.
   */
  private stealIfStale(): boolean {
    if (!this.isStale()) {
      return false;
    }
    const retiredPath = `${this.lockPath}.retired.${process.pid}.${randomUUID()}`;
    try {
      renameSync(this.lockPath, retiredPath);
    } catch {
      return false;
    }
    rmSync(retiredPath, { force: true });
    return true;
  }

  private release(token: string): void {
    try {
      const current = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: unknown };
      if (current.token === token) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Already released or stolen; ignore.
    }
  }
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
