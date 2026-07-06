import { sha256Hex, canonicalize } from "./addressing.js";
import type { Cell, Cid, NodeIdent, NodeSelector, State } from "./types.js";

/** An empty tree. */
export function emptyState(): State {
  return { kind: "state", cells: {} };
}

/**
 * Mint a stable NodeIdent at Cell creation. Identity is a function of the
 * creating Transform, an ordinal within it, and the initial path — never of the
 * content, so it survives moves and content edits (design §2.3).
 */
export function mintNodeIdent(
  creatingTransform: Cid,
  ordinal: number,
  initialPath: string
): NodeIdent {
  const digest = sha256Hex(canonicalize({ creatingTransform, ordinal, initialPath }));
  return `nid:${digest.slice(0, 32)}` as NodeIdent;
}

/** Derive nid -> path from a State (each Cell carries its stable ident). */
export function deriveIdentityIndex(state: State): ReadonlyMap<NodeIdent, string> {
  const index = new Map<NodeIdent, string>();
  for (const [path, cell] of Object.entries(state.cells)) {
    index.set(cell.ident, path);
  }
  return index;
}

/** Resolve a selector to its current path + Cell, or undefined if absent. */
export function resolveSelector(
  state: State,
  sel: NodeSelector
): { readonly path: string; readonly cell: Cell } | undefined {
  if ("path" in sel) {
    const cell = state.cells[sel.path];
    return cell ? { path: sel.path, cell } : undefined;
  }
  const path = deriveIdentityIndex(state).get(sel.nid);
  if (path === undefined) {
    return undefined;
  }
  const cell = state.cells[path];
  return cell ? { path, cell } : undefined;
}
