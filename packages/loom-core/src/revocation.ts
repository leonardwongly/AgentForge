/**
 * @agentforge/loom-core — Grant revocation (Phase 1, spec §12.2).
 *
 * A revocation registry tracks grants that have been revoked. Revocation is
 * permanent: a revoked grant is filtered out of any authorization chain before
 * it is evaluated, so it can no longer authorize actions. The registry is
 * optionally file-backed for persistence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class GrantRevocationRegistry {
  private revoked = new Set<string>();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as { revoked: string[] };
      this.revoked = new Set(data.revoked ?? []);
    }
  }

  /** Permanently revoke a grant by id. Idempotent. */
  revoke(grantId: string): void {
    this.revoked.add(grantId);
    this.persist();
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
      writeFileSync(this.file, JSON.stringify({ revoked: [...this.revoked] }), "utf8");
    }
  }
}
