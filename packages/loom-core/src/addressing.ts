import { createHash } from "node:crypto";
import type { Cell, Cid, State } from "./types.js";

/**
 * Deterministic canonical encoding (v1): JSON with recursively sorted object
 * keys. This yields a stable byte string for content addressing. The design
 * targets DAG-CBOR; canonical JSON is a faithful, dependency-free stand-in with
 * identical determinism guarantees for these object shapes.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("loom: cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    // Undefined is not representable; callers must omit optional fields instead.
    throw new Error("loom: cannot canonicalize undefined");
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(",")}}`;
  }
  throw new Error(`loom: cannot canonicalize value of type ${typeof value}`);
}

/** SHA-256 hex of arbitrary bytes/text. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Content address of any canonically-encodable object. */
export function address(value: unknown): Cid {
  return `loom:sha256:${sha256Hex(canonicalize(value))}` as Cid;
}

/** Address of a single Cell. */
export function cellAddress(cell: Cell): Cid {
  return address(cell);
}

/** Address of a whole-tree State (keys are sorted by canonicalize). */
export function stateAddress(state: State): Cid {
  return address(state);
}

/** Recompute and compare; a single changed bit fails. */
export function verifyAddress(cid: Cid, value: unknown): boolean {
  return address(value) === cid;
}
