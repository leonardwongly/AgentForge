/**
 * @agentforge/loom-core — Grant revocation (Phase 1, spec §12.2).
 *
 * A revocation registry tracks grants that have been revoked. Revocation is
 * permanent: a revoked grant is filtered out of any authorization chain before
 * it is evaluated, so it can no longer authorize actions. The registry is
 * optionally file-backed for persistence.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { FileLock } from "./lock.js";

export class GrantRevocationRegistry {
  private revoked = new Set<string>();

  constructor(private readonly file?: string) {
    this.reload();
  }

  /** Permanently revoke a grant by id. Idempotent. */
  revoke(grantId: string): void {
    this.withLockedMutation(() => this.revoked.add(grantId));
  }

  /** True if the grant has been revoked. */
  isRevoked(grantId: string): boolean {
    return this.revoked.has(grantId);
  }

  /** Remove revoked grants from a chain, preserving order. */
  filterActive<T extends { readonly id: string }>(chain: readonly T[]): T[] {
    return chain.filter((grant) => !this.revoked.has(grant.id));
  }

  private persist(): void {
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = join(
        dirname(this.file),
        `.${basename(this.file)}.${process.pid}.${randomUUID()}.tmp`
      );
      writeFileSync(temp, JSON.stringify({ revoked: [...this.revoked] }), {
        encoding: "utf8",
        flag: "wx"
      });
      renameSync(temp, this.file);
    }
  }

  private reload(): void {
    if (!this.file || !existsSync(this.file)) return;
    if (statSync(this.file).size > 1_048_576)
      throw new Error("loom: revocation registry is too large");
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.revoked) ||
      parsed.revoked.some((id) => typeof id !== "string" || id.length > 512)
    ) {
      throw new Error("loom: malformed revocation registry");
    }
    this.revoked = new Set(parsed.revoked);
  }

  private withLockedMutation(mutation: () => void): void {
    if (!this.file) {
      mutation();
      return;
    }
    const lock = new FileLock(dirname(this.file), `revocation:${this.file}`);
    const release = lock.acquireSync();
    try {
      this.reload();
      mutation();
      this.persist();
    } finally {
      release();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
