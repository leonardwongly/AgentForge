/**
 * @agentforge/loom-core — the merge floor.
 *
 * This is the mandatory git-class safety floor from
 * docs/loom/reapply-merge-engine.md (§2): LCA over the lineage DAG plus diff3
 * text 3-way, scoped to Cells by stable {@link NodeIdent} so that moves compose
 * instead of conflicting. Everything here is deterministic and dependency-free.
 *
 * `reapply` (see reapply.ts) is the optimization layered on top of this floor;
 * it never replaces it. When any optimization is uncertain the engine falls back
 * to text 3-way and, failing that, to a typed human {@link Conflict}.
 */

import { cellAddress } from "./addressing.js";
import { deriveIdentityIndex } from "./identity.js";
import type { Cell, Cid, Conflict, ConflictClass, MergeResult, NodeIdent, State } from "./types.js";

/** A lineage DAG: each Transform Cid maps to its parent Cids. */
export type TransformGraph = ReadonlyMap<Cid, ReadonlyArray<Cid>>;

/**
 * Lowest common ancestor over the lineage DAG (git `merge-base`, §2.1).
 *
 * Returns the common ancestor closest to both `a` and `b` — i.e. a common
 * ancestor that is not itself a (proper) ancestor of any other common ancestor.
 * When several such maximal ancestors exist (a criss-cross history) the result
 * is chosen deterministically by Cid ordering. Returns `undefined` when the two
 * nodes share no ancestor at all.
 */
export function lca(graph: TransformGraph, a: Cid, b: Cid): Cid | undefined {
  const ancestorsA = ancestorsOf(graph, a);
  const ancestorsB = ancestorsOf(graph, b);

  const common: Cid[] = [];
  for (const cid of ancestorsA) {
    if (ancestorsB.has(cid)) {
      common.push(cid);
    }
  }
  if (common.length === 0) {
    return undefined;
  }

  // Keep only the "lowest" common ancestors: those that are not a proper
  // ancestor of any other common ancestor.
  const lowest: Cid[] = [];
  for (const candidate of common) {
    let isAncestorOfAnother = false;
    for (const other of common) {
      if (other === candidate) {
        continue;
      }
      if (ancestorsOf(graph, other).has(candidate)) {
        isAncestorOfAnother = true;
        break;
      }
    }
    if (!isAncestorOfAnother) {
      lowest.push(candidate);
    }
  }

  lowest.sort();
  return lowest[0];
}

/** All ancestors of `start` following parent edges, inclusive of `start`. */
function ancestorsOf(graph: TransformGraph, start: Cid): ReadonlySet<Cid> {
  const seen = new Set<Cid>();
  const stack: Cid[] = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const parents = graph.get(node);
    if (parents !== undefined) {
      for (const parent of parents) {
        stack.push(parent);
      }
    }
  }
  return seen;
}

/**
 * Line-based diff3 over the text facet (§2.1, the mandatory floor).
 *
 * Regions changed by only one side are taken from that side; regions both sides
 * changed identically are taken once; regions both sides changed differently
 * produce git-style conflict markers and set `conflict: true`.
 */
export function textThreeWay(
  base: string,
  ours: string,
  theirs: string
): { readonly text: string; readonly conflict: boolean } {
  const o = base.split("\n");
  const a = ours.split("\n");
  const b = theirs.split("\n");

  const aOf = new Map<number, number>();
  for (const [oi, ai] of longestCommonSubsequence(o, a)) {
    aOf.set(oi, ai);
  }
  const bOf = new Map<number, number>();
  for (const [oi, bi] of longestCommonSubsequence(o, b)) {
    bOf.set(oi, bi);
  }

  // Anchors are base lines present unchanged in BOTH sides; between anchors sit
  // the unstable regions that diff3 must reconcile. A trailing sentinel closes
  // the final region.
  const anchors: Array<{ readonly o: number; readonly a: number; readonly b: number }> = [];
  for (let oi = 0; oi < o.length; oi++) {
    const ai = aOf.get(oi);
    const bi = bOf.get(oi);
    if (ai !== undefined && bi !== undefined) {
      anchors.push({ o: oi, a: ai, b: bi });
    }
  }
  anchors.push({ o: o.length, a: a.length, b: b.length });

  const out: string[] = [];
  let conflict = false;
  let oi = 0;
  let ai = 0;
  let bi = 0;

  for (const anchor of anchors) {
    const oSlice = o.slice(oi, anchor.o);
    const aSlice = a.slice(ai, anchor.a);
    const bSlice = b.slice(bi, anchor.b);

    if (oSlice.length > 0 || aSlice.length > 0 || bSlice.length > 0) {
      if (linesEqual(aSlice, oSlice)) {
        // Only theirs changed this region.
        pushAll(out, bSlice);
      } else if (linesEqual(bSlice, oSlice)) {
        // Only ours changed this region.
        pushAll(out, aSlice);
      } else if (linesEqual(aSlice, bSlice)) {
        // Both sides made the identical change.
        pushAll(out, aSlice);
      } else {
        conflict = true;
        out.push("<<<<<<< ours");
        pushAll(out, aSlice);
        out.push("=======");
        pushAll(out, bSlice);
        out.push(">>>>>>> theirs");
      }
    }

    if (anchor.o < o.length) {
      const stable = o[anchor.o];
      if (stable !== undefined) {
        out.push(stable);
      }
      oi = anchor.o + 1;
      ai = anchor.a + 1;
      bi = anchor.b + 1;
    }
  }

  return { text: out.join("\n"), conflict };
}

/**
 * Classify each touched Cell (by stable {@link NodeIdent}) as `independent`,
 * `commuting`, or `conflict` relative to `base` (§2.3).
 *
 * - `independent`: only one side changed the Cell (compose both).
 * - `commuting`: one side moved the Cell while the other edited its content, or
 *   both sides agreed (identical add/delete/move); these compose safely.
 * - `conflict`: both sides changed the content differently, or a delete raced an
 *   edit, or two moves diverged. Conservative — anything uncertain is a conflict.
 */
export function classify(
  base: State,
  ours: State,
  theirs: State
): ReadonlyMap<NodeIdent, ConflictClass> {
  const baseIndex = deriveIdentityIndex(base);
  const oursIndex = deriveIdentityIndex(ours);
  const theirsIndex = deriveIdentityIndex(theirs);

  const nids = new Set<NodeIdent>([
    ...baseIndex.keys(),
    ...oursIndex.keys(),
    ...theirsIndex.keys()
  ]);
  const out = new Map<NodeIdent, ConflictClass>();

  for (const nid of nids) {
    const view = nidView(nid, base, ours, theirs, baseIndex, oursIndex, theirsIndex);
    const cls = classifyNid(view);
    if (cls !== undefined) {
      out.set(nid, cls);
    }
  }
  return out;
}

/**
 * Combine two lineages into one candidate State plus a list of typed conflicts
 * (§3.4, CONFLICT branch). Independent and commuting changes compose
 * automatically; conflicting content is reconciled with {@link textThreeWay} and
 * surfaced as a {@link Conflict} only when diff3 itself reports a textual clash.
 * A delete racing an edit is a `delete/edit` conflict.
 */
export function mergeStates(base: State, ours: State, theirs: State): MergeResult {
  const classes = classify(base, ours, theirs);
  const baseIndex = deriveIdentityIndex(base);
  const oursIndex = deriveIdentityIndex(ours);
  const theirsIndex = deriveIdentityIndex(theirs);

  const nids = new Set<NodeIdent>([
    ...baseIndex.keys(),
    ...oursIndex.keys(),
    ...theirsIndex.keys()
  ]);
  const sortedNids = [...nids].sort();

  const resolutions = new Map<NodeIdent, { readonly path: string; readonly cell: Cell }>();
  const conflicts: Conflict[] = [];

  for (const nid of sortedNids) {
    const view = nidView(nid, base, ours, theirs, baseIndex, oursIndex, theirsIndex);
    const cls = classes.get(nid);
    const resolved = resolveNid(nid, view, cls, conflicts);
    if (resolved !== undefined) {
      resolutions.set(nid, resolved);
    }
  }

  const cells: Record<string, Cell> = {};
  for (const nid of sortedNids) {
    const resolved = resolutions.get(nid);
    if (resolved !== undefined) {
      cells[resolved.path] = resolved.cell;
    }
  }

  return { candidate: { kind: "state", cells }, conflicts };
}

// ---- internals -------------------------------------------------------------

interface NidView {
  readonly basePath: string | undefined;
  readonly baseCell: Cell | undefined;
  readonly oursPath: string | undefined;
  readonly oursCell: Cell | undefined;
  readonly theirsPath: string | undefined;
  readonly theirsCell: Cell | undefined;
  readonly oursContentChanged: boolean;
  readonly theirsContentChanged: boolean;
  readonly oursMoved: boolean;
  readonly theirsMoved: boolean;
  readonly oursTouched: boolean;
  readonly theirsTouched: boolean;
}

function nidView(
  nid: NodeIdent,
  base: State,
  ours: State,
  theirs: State,
  baseIndex: ReadonlyMap<NodeIdent, string>,
  oursIndex: ReadonlyMap<NodeIdent, string>,
  theirsIndex: ReadonlyMap<NodeIdent, string>
): NidView {
  const basePath = baseIndex.get(nid);
  const baseCell = basePath !== undefined ? base.cells[basePath] : undefined;
  const oursPath = oursIndex.get(nid);
  const oursCell = oursPath !== undefined ? ours.cells[oursPath] : undefined;
  const theirsPath = theirsIndex.get(nid);
  const theirsCell = theirsPath !== undefined ? theirs.cells[theirsPath] : undefined;

  const oursContentChanged = contentChanged(baseCell, oursCell);
  const theirsContentChanged = contentChanged(baseCell, theirsCell);
  const oursMoved = baseCell !== undefined && oursCell !== undefined && basePath !== oursPath;
  const theirsMoved = baseCell !== undefined && theirsCell !== undefined && basePath !== theirsPath;

  return {
    basePath,
    baseCell,
    oursPath,
    oursCell,
    theirsPath,
    theirsCell,
    oursContentChanged,
    theirsContentChanged,
    oursMoved,
    theirsMoved,
    oursTouched: oursContentChanged || oursMoved,
    theirsTouched: theirsContentChanged || theirsMoved
  };
}

function classifyNid(view: NidView): ConflictClass | undefined {
  if (!view.oursTouched && !view.theirsTouched) {
    return undefined;
  }
  if (view.oursTouched !== view.theirsTouched) {
    return "independent";
  }

  const oursDeleted = view.baseCell !== undefined && view.oursCell === undefined;
  const theirsDeleted = view.baseCell !== undefined && view.theirsCell === undefined;
  if (oursDeleted && theirsDeleted) {
    return "commuting";
  }
  if (oursDeleted || theirsDeleted) {
    return "conflict";
  }

  const oursAdded = view.baseCell === undefined && view.oursCell !== undefined;
  const theirsAdded = view.baseCell === undefined && view.theirsCell !== undefined;
  if (oursAdded && theirsAdded) {
    return sameCellAndPath(view.oursCell, view.theirsCell, view.oursPath, view.theirsPath)
      ? "commuting"
      : "conflict";
  }

  if (view.oursContentChanged && view.theirsContentChanged) {
    if (
      view.oursCell !== undefined &&
      view.theirsCell !== undefined &&
      cellAddress(view.oursCell) === cellAddress(view.theirsCell)
    ) {
      return view.oursPath === view.theirsPath ? "commuting" : "conflict";
    }
    return "conflict";
  }

  const oneMovedOtherEdited =
    (view.oursMoved &&
      !view.oursContentChanged &&
      view.theirsContentChanged &&
      !view.theirsMoved) ||
    (view.theirsMoved && !view.theirsContentChanged && view.oursContentChanged && !view.oursMoved);
  if (oneMovedOtherEdited) {
    return "commuting";
  }

  if (
    view.oursMoved &&
    view.theirsMoved &&
    !view.oursContentChanged &&
    !view.theirsContentChanged
  ) {
    return view.oursPath === view.theirsPath ? "commuting" : "conflict";
  }

  // Fail-safe: anything the classifier cannot prove commutes falls to text 3-way.
  return "conflict";
}

function resolveNid(
  nid: NodeIdent,
  view: NidView,
  cls: ConflictClass | undefined,
  conflicts: Conflict[]
): { readonly path: string; readonly cell: Cell } | undefined {
  if (cls === undefined) {
    // Untouched: preserve whichever lineage still carries the Cell (base first).
    return (
      present(view.basePath, view.baseCell) ??
      present(view.oursPath, view.oursCell) ??
      present(view.theirsPath, view.theirsCell)
    );
  }

  if (cls === "independent") {
    if (view.oursTouched) {
      return present(view.oursPath, view.oursCell);
    }
    return present(view.theirsPath, view.theirsCell);
  }

  if (cls === "commuting") {
    const oursDeleted = view.baseCell !== undefined && view.oursCell === undefined;
    const theirsDeleted = view.baseCell !== undefined && view.theirsCell === undefined;
    if (oursDeleted && theirsDeleted) {
      return undefined;
    }
    const finalCell = view.oursContentChanged
      ? view.oursCell
      : view.theirsContentChanged
        ? view.theirsCell
        : view.baseCell;
    const finalPath = view.oursMoved
      ? view.oursPath
      : view.theirsMoved
        ? view.theirsPath
        : view.basePath;
    if (finalCell !== undefined && finalPath !== undefined) {
      return { path: finalPath, cell: finalCell };
    }
    return undefined;
  }

  // cls === "conflict"
  const oursDeleted = view.baseCell !== undefined && view.oursCell === undefined;
  const theirsDeleted = view.baseCell !== undefined && view.theirsCell === undefined;
  if (oursDeleted !== theirsDeleted) {
    const survivorCell = oursDeleted ? view.theirsCell : view.oursCell;
    const survivorPath = oursDeleted ? view.theirsPath : view.oursPath;
    const conflictPath = survivorPath ?? view.basePath ?? "";
    conflicts.push(
      makeConflict(nid, conflictPath, "delete/edit", {
        base: view.baseCell?.text,
        ours: view.oursCell?.text,
        theirs: view.theirsCell?.text
      })
    );
    if (survivorCell !== undefined && survivorPath !== undefined) {
      return { path: survivorPath, cell: survivorCell };
    }
    return undefined;
  }

  if (view.oursCell !== undefined && view.theirsCell !== undefined) {
    const baseText = view.baseCell?.text ?? "";
    const merged = textThreeWay(baseText, view.oursCell.text, view.theirsCell.text);
    const finalPath = view.oursPath ?? view.theirsPath ?? view.basePath ?? "";
    const mergedCell = withText(view.oursCell, nid, merged.text);
    if (merged.conflict) {
      conflicts.push(
        makeConflict(nid, finalPath, "content", {
          base: baseText,
          ours: view.oursCell.text,
          theirs: view.theirsCell.text,
          textConflict: merged.text
        })
      );
    }
    return { path: finalPath, cell: mergedCell };
  }

  return present(view.basePath, view.baseCell);
}

function present(
  path: string | undefined,
  cell: Cell | undefined
): { readonly path: string; readonly cell: Cell } | undefined {
  if (path !== undefined && cell !== undefined) {
    return { path, cell };
  }
  return undefined;
}

function contentChanged(baseCell: Cell | undefined, sideCell: Cell | undefined): boolean {
  if (baseCell === undefined && sideCell === undefined) {
    return false;
  }
  if (baseCell === undefined || sideCell === undefined) {
    return true;
  }
  return cellAddress(baseCell) !== cellAddress(sideCell);
}

function sameCellAndPath(
  a: Cell | undefined,
  b: Cell | undefined,
  aPath: string | undefined,
  bPath: string | undefined
): boolean {
  return a !== undefined && b !== undefined && cellAddress(a) === cellAddress(b) && aPath === bPath;
}

/** Rebuild a Cell at the same identity with new text, preserving facet and mode. */
function withText(template: Cell, ident: NodeIdent, text: string): Cell {
  return template.mode === undefined
    ? { facet: template.facet, ident, text }
    : { facet: template.facet, ident, text, mode: template.mode };
}

function makeConflict(
  nid: NodeIdent,
  path: string,
  kind: Conflict["kind"],
  parts: {
    readonly base?: string | undefined;
    readonly ours?: string | undefined;
    readonly theirs?: string | undefined;
    readonly textConflict?: string | undefined;
    readonly suggestedResolution?: string | undefined;
  }
): Conflict {
  return {
    nid,
    path,
    kind,
    ...(parts.base !== undefined ? { base: parts.base } : {}),
    ...(parts.ours !== undefined ? { ours: parts.ours } : {}),
    ...(parts.theirs !== undefined ? { theirs: parts.theirs } : {}),
    ...(parts.textConflict !== undefined ? { textConflict: parts.textConflict } : {}),
    ...(parts.suggestedResolution !== undefined
      ? { suggestedResolution: parts.suggestedResolution }
      : {})
  };
}

function pushAll(target: string[], lines: ReadonlyArray<string>): void {
  for (const line of lines) {
    target.push(line);
  }
}

function linesEqual(x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean {
  if (x.length !== y.length) {
    return false;
  }
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Longest common subsequence as an increasing list of (indexInX, indexInY)
 * matched pairs. Dependency-free DP; used to align diff3 anchors.
 */
function longestCommonSubsequence(
  x: ReadonlyArray<string>,
  y: ReadonlyArray<string>
): ReadonlyArray<readonly [number, number]> {
  const n = x.length;
  const m = y.length;
  const width = m + 1;
  const dp = new Array<number>(width * (n + 1)).fill(0);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (x[i] === y[j]) {
        dp[i * width + j] = at(i + 1, j + 1) + 1;
      } else {
        dp[i * width + j] = Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
  }

  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
