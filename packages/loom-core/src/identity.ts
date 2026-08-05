import { sha256Hex, canonicalize } from "./addressing.js";
import type { Cell, Cid, NodeIdent, NodeSelector, State } from "./types.js";

/** An empty tree backed by a path map with no inherited property names. */
export function emptyState(): State {
  return { kind: "state", cells: Object.create(null) as Record<string, Cell> };
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

/**
 * Derive nid -> path from a State (each Cell carries its stable ident).
 * Duplicate identities make selector resolution ambiguous and therefore fail
 * closed. Sorting by path keeps the diagnostic independent of insertion order.
 */
export function deriveIdentityIndex(state: State): ReadonlyMap<NodeIdent, string> {
  const index = new Map<NodeIdent, string>();
  const entries = Object.entries(state.cells).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, cell] of entries) {
    const previousPath = index.get(cell.ident);
    if (previousPath !== undefined) {
      throw new Error(
        `loom: duplicate NodeIdent ${JSON.stringify(cell.ident)} at paths ${JSON.stringify(previousPath)} and ${JSON.stringify(path)}`
      );
    }
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
    if (!Object.hasOwn(state.cells, sel.path)) {
      return undefined;
    }
    const cell = state.cells[sel.path];
    return cell === undefined ? undefined : { path: sel.path, cell };
  }
  const path = deriveIdentityIndex(state).get(sel.nid);
  if (path === undefined || !Object.hasOwn(state.cells, path)) {
    return undefined;
  }
  const cell = state.cells[path];
  return cell === undefined ? undefined : { path, cell };
}
