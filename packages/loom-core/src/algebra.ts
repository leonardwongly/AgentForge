import { resolveSelector } from "./identity.js";
import type { ApplyResult, Cell, Effect, EffectCheck, Op, State } from "./types.js";

const TEST_PATH = /(^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[a-z0-9]+$/iu;

/** Whether a path is a test file/dir (used for the deletes_test/skips_test effects). */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Apply a sequence of Ops to a State, checking preconditions. Pure. */
export function applyOps(state: State, ops: ReadonlyArray<Op>): ApplyResult {
  const cells: Record<string, Cell> = { ...state.cells };

  for (const op of ops) {
    switch (op.op) {
      case "put_cell": {
        const cell: Cell =
          op.mode === undefined
            ? { facet: op.facet, ident: op.ident, text: op.text }
            : { facet: op.facet, ident: op.ident, text: op.text, mode: op.mode };
        cells[op.at] = cell;
        break;
      }
      case "delete_cell": {
        const found = resolveSelector({ kind: "state", cells }, op.sel);
        if (!found) {
          return fail("precondition", `delete_cell: selector does not resolve`);
        }
        delete cells[found.path];
        break;
      }
      case "move_cell": {
        const found = resolveSelector({ kind: "state", cells }, op.sel);
        if (!found) {
          return fail("precondition", `move_cell: selector does not resolve`);
        }
        if (op.to !== found.path && cells[op.to] !== undefined) {
          return fail("precondition", `move_cell: target path already occupied: ${op.to}`);
        }
        // Identity and content are preserved across the move.
        delete cells[found.path];
        cells[op.to] = found.cell;
        break;
      }
      case "patch_text": {
        const found = resolveSelector({ kind: "state", cells }, op.sel);
        if (!found) {
          return fail("precondition", `patch_text: selector does not resolve`);
        }
        const [start, end] = op.range;
        const len = found.cell.text.length;
        if (start < 0 || end < start || end > len) {
          return fail(
            "precondition",
            `patch_text: range [${start},${end}] out of bounds (len ${len})`
          );
        }
        const nextText = found.cell.text.slice(0, start) + op.text + found.cell.text.slice(end);
        cells[found.path] = { ...found.cell, text: nextText };
        break;
      }
      default: {
        // Exhaustiveness guard.
        const never: never = op;
        return fail("precondition", `unknown op ${JSON.stringify(never)}`);
      }
    }
  }

  return { ok: true, state: { kind: "state", cells } };
}

function fail(code: "precondition" | "scope_violation", detail: string): ApplyResult {
  return { ok: false, error: { code, detail } };
}

/** Structural effects implied by ops against a base State (conservative). */
export function impliedEffects(base: State, ops: ReadonlyArray<Op>): ReadonlyArray<Effect> {
  const effects = new Set<Effect>();
  for (const op of ops) {
    switch (op.op) {
      case "put_cell": {
        effects.add("edits_source");
        break;
      }
      case "patch_text": {
        effects.add("edits_source");
        const found = resolveSelector(base, op.sel);
        if (found && isTestPath(found.path)) {
          effects.add("skips_test");
        }
        break;
      }
      case "move_cell": {
        effects.add("moves_cell");
        break;
      }
      case "delete_cell": {
        effects.add("deletes_source");
        const found = resolveSelector(base, op.sel);
        if (found && isTestPath(found.path)) {
          effects.add("deletes_test");
        }
        break;
      }
      default:
        break;
    }
  }
  return [...effects];
}

/** Declared effects must be a superset of implied effects (under-declaration rejected). */
export function verifyEffects(
  declared: ReadonlyArray<Effect>,
  implied: ReadonlyArray<Effect>
): EffectCheck {
  const declaredSet = new Set(declared);
  const impliedSet = new Set(implied);
  const missing = implied.filter((e) => !declaredSet.has(e));
  const extra = declared.filter((e) => !impliedSet.has(e));
  return { ok: missing.length === 0, missing, extra };
}
