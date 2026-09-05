/**
 * @agentforge/loom-core — delegated agent sessions (Phase 3, spec §10.4).
 *
 * An agent session is a bounded, traceable unit of delegated work. It binds an
 * agent DID to a Grant (authority) and a write scope (path prefixes the agent
 * may modify), and carries a resource budget. A session can only write within
 * its scope and within its budget, so concurrent agents cannot interfere
 * outside their delegated bounds.
 */

import { randomUUID } from "node:crypto";

import type { Did } from "./types.js";

export type SessionStatus = "active" | "completed" | "cancelled";

export interface AgentSession {
  readonly id: string;
  readonly agentDid: Did;
  readonly grantId: string;
  /** Path prefixes the agent is allowed to write. */
  readonly writeScope: readonly string[];
  readonly maxWrites: number;
  status: SessionStatus;
  readonly createdAt: number;
  writes: number;
}

export interface CreateSessionInput {
  readonly agentDid: Did;
  readonly grantId: string;
  readonly writeScope: readonly string[];
  readonly maxWrites?: number | undefined;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(input: CreateSessionInput): AgentSession {
    if (!Number.isSafeInteger(input.maxWrites ?? 10_000) || (input.maxWrites ?? 10_000) < 0) {
      throw new Error("loom: maxWrites must be a non-negative safe integer");
    }
    const writeScope = Object.freeze([...input.writeScope]);
    if (writeScope.some((prefix) => !isValidScopePrefix(prefix))) {
      throw new Error("loom: writeScope contains an invalid path prefix");
    }
    const state = { status: "active" as SessionStatus, writes: 0 };
    const session = Object.freeze({
      id: randomUUID(),
      agentDid: input.agentDid,
      grantId: input.grantId,
      writeScope,
      maxWrites: input.maxWrites ?? 10_000,
      createdAt: Date.now(),
      get status(): SessionStatus {
        return state.status;
      },
      get writes(): number {
        return state.writes;
      }
    }) as AgentSession;
    this.sessions.set(session.id, { session, state });
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)?.session;
  }

  /** True if the session may write to `path` (within scope and budget). */
  canWrite(session: AgentSession, path: string): boolean {
    const owned = this.ownedSession(session);
    if (owned === undefined || owned.status !== "active") {
      return false;
    }
    if (owned.writes >= owned.maxWrites || !isSafeRelativePath(path)) {
      return false;
    }
    return owned.writeScope.some((prefix) => pathWithinScope(path, prefix));
  }

  /** Record a write; returns false if the write is not permitted. */
  recordWrite(session: AgentSession, path: string): boolean {
    const owned = this.ownedSession(session);
    if (owned === undefined || !this.canWrite(owned, path)) {
      return false;
    }
    const record = this.sessions.get(owned.id);
    if (record === undefined) {
      return false;
    }
    record.state.writes += 1;
    return true;
  }

  complete(id: string): AgentSession | undefined {
    return this.transition(id, "completed");
  }

  cancel(id: string): AgentSession | undefined {
    return this.transition(id, "cancelled");
  }

  private transition(id: string, next: SessionStatus): AgentSession | undefined {
    const record = this.sessions.get(id);
    if (!record || record.state.status !== "active") {
      return record?.session;
    }
    record.state.status = next;
    return record.session;
  }

  /** Resolve only the exact object issued by this store; forged session records
   * with a copied id must never inherit another session's authority. */
  private ownedSession(session: AgentSession): AgentSession | undefined {
    if (typeof session !== "object" || session === null || typeof session.id !== "string") {
      return undefined;
    }
    const owned = this.sessions.get(session.id);
    return owned?.session === session ? owned.session : undefined;
  }
}

interface SessionRecord {
  readonly session: AgentSession;
  readonly state: { status: SessionStatus; writes: number };
}

function isValidScopePrefix(prefix: unknown): prefix is string {
  return (
    typeof prefix === "string" &&
    prefix.length > 0 &&
    isSafeRelativePath(prefix.replace(/\/$/u, ""))
  );
}

function isSafeRelativePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes("\u0000")
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Match complete path segments, not just a textual prefix (`src` must not
 * authorize `src-private`). A trailing slash remains a directory scope. */
export function pathWithinScope(path: string, prefix: string): boolean {
  if (!isSafeRelativePath(path) || !isValidScopePrefix(prefix)) {
    return false;
  }
  const normalizedPrefix = prefix.replace(/\/$/u, "");
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}
