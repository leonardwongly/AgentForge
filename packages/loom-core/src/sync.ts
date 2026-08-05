/**
 * @agentforge/loom-core — replication and synchronization (Phase 1, spec §16).
 *
 * Replicates objects from a source store to a target store. Because objects are
 * content-addressed and immutable, replication is idempotent: an object already
 * present at the target is never rewritten, and the same content always maps to
 * the same CID at both ends.
 */

import type { FileObjectStore } from "./store.js";

/**
 * Copy every object from `source` to `target` that the target does not already
 * have. Returns the number of objects copied.
 */
export function replicate(source: FileObjectStore, target: FileObjectStore): number {
  let copied = 0;
  for (const cid of source.listCids()) {
    if (source.hasRaw(cid)) {
      if (!target.hasRaw(cid)) {
        const bytes = source.getRaw(cid);
        if (bytes !== undefined) {
          target.putRaw(bytes);
          copied++;
        }
      }
    } else if (source.hasDagCbor(cid)) {
      if (!target.hasDagCbor(cid)) {
        const value = source.getDagCbor(cid);
        if (value !== undefined) {
          target.putDagCbor(value);
          copied++;
        }
      }
    } else if (!target.has(cid)) {
      const value = source.get(cid);
      if (value !== undefined) {
        target.put(value);
        copied++;
      }
    }
  }
  return copied;
}
