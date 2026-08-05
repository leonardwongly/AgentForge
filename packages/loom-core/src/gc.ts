/**
 * @agentforge/loom-core — garbage collection (Phase 1, spec §17.3).
 *
 * Collects unreachable objects from the store. Reachability is computed from a
 * set of root CIDs by following object references (provided by the caller, who
 * knows how each object type references others). Any object not reachable from
 * a root is deleted. Roots are always retained.
 */

import type { Cid } from "./types.js";
import type { FileObjectStore } from "./store.js";

export interface GarbageCollectionResult {
  readonly retained: number;
  readonly collected: number;
  readonly collectedCids: readonly Cid[];
}

/**
 * Delete every stored object not reachable from `roots`.
 * `references(cid)` returns the CIDs an object references (or [] if unknown).
 */
export function collectGarbage(
  store: FileObjectStore,
  roots: readonly Cid[],
  references: (cid: Cid) => readonly Cid[]
): GarbageCollectionResult {
  const reachable = new Set<Cid>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const cid = queue.pop()!;
    for (const ref of references(cid)) {
      if (!reachable.has(ref)) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }

  const collectedCids: Cid[] = [];
  for (const cid of store.listCids()) {
    if (!reachable.has(cid)) {
      store.delete(cid);
      collectedCids.push(cid);
    }
  }
  return {
    retained: reachable.size,
    collected: collectedCids.length,
    collectedCids
  };
}
