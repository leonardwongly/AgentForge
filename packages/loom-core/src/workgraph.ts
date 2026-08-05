/**
 * @agentforge/loom-core — agent work graph (Phase 3, spec §10.4).
 *
 * A directed acyclic graph of work nodes (agent sessions and their resulting
 * transforms) with explicit dependency edges, so concurrent agent work can be
 * ordered, validated for cycles, and traced back to the authority that produced
 * it. A cycle is rejected because it would make ordering and replay ambiguous.
 */

import { randomUUID } from "node:crypto";

export interface WorkNode {
  readonly id: string;
  readonly agentDid: string;
  readonly sessionId: string;
  /** The transform CID this work produced (or undefined while in progress). */
  readonly transformCid?: string | undefined;
  readonly title: string;
}

export interface WorkGraphInput {
  readonly agentDid: string;
  readonly sessionId: string;
  readonly transformCid?: string | undefined;
  readonly title?: string | undefined;
}

export class WorkGraph {
  private readonly nodes = new Map<string, WorkNode>();
  private readonly edges = new Map<string, Set<string>>(); // node -> dependents

  addNode(input: WorkGraphInput): WorkNode {
    const node: WorkNode = {
      id: randomUUID(),
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      transformCid: input.transformCid,
      title: input.title ?? "work"
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /** Add a dependency edge `from -> to` (to depends on from). */
  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error("loom: work graph edge references an unknown node");
    }
    if (from === to) {
      throw new Error("loom: work graph self-edge is not allowed");
    }
    const dependents = this.edges.get(from) ?? new Set<string>();
    dependents.add(to);
    this.edges.set(from, dependents);
  }

  get(id: string): WorkNode | undefined {
    return this.nodes.get(id);
  }

  /** Topological order (dependencies before dependents), or undefined on a cycle. */
  topologicalOrder(): WorkNode[] | undefined {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }
    for (const [, dependents] of this.edges) {
      for (const dependent of dependents) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }
    const order: WorkNode[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(this.nodes.get(id)!);
      for (const dependent of this.edges.get(id) ?? []) {
        const next = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, next);
        if (next === 0) {
          queue.push(dependent);
        }
      }
    }
    return order.length === this.nodes.size ? order : undefined;
  }

  hasCycle(): boolean {
    return this.topologicalOrder() === undefined;
  }
}
