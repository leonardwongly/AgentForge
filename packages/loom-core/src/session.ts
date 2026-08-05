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
  private readonly sessions = new Map<string, AgentSession>();

  create(input: CreateSessionInput): AgentSession {
    const session: AgentSession = {
      id: randomUUID(),
      agentDid: input.agentDid,
      grantId: input.grantId,
      writeScope: input.writeScope,
      maxWrites: input.maxWrites ?? 10_000,
      status: "active",
      createdAt: Date.now(),
      writes: 0
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /** True if the session may write to `path` (within scope and budget). */
  canWrite(session: AgentSession, path: string): boolean {
    if (session.status !== "active") {
      return false;
    }
    if (session.writes >= session.maxWrites) {
      return false;
    }
    return session.writeScope.some((prefix) => path.startsWith(prefix));
  }

  /** Record a write; returns false if the write is not permitted. */
  recordWrite(session: AgentSession, path: string): boolean {
    if (!this.canWrite(session, path)) {
      return false;
    }
    session.writes += 1;
    return true;
  }

  complete(id: string): AgentSession | undefined {
    return this.transition(id, "completed");
  }

  cancel(id: string): AgentSession | undefined {
    return this.transition(id, "cancelled");
  }

  private transition(id: string, next: SessionStatus): AgentSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.status !== "active") {
      return session;
    }
    session.status = next;
    return session;
  }
}
