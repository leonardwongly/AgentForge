/**
 * @agentforge/loom-core — capability authorization (design §9.5).
 *
 * A Grant delegates a bounded slice of authority — the product
 * `transformTypes × cellSelectors × effectBounds` — from an issuer to an
 * audience. `authorize` verifies that a delegation chain rooted at a Shared
 * Line's controller grants a concrete actor the right to apply a concrete set
 * of ops/effects over a concrete set of cells.
 *
 * The check is deterministic and **fails closed**: any selector it cannot
 * decide, any broadened (non-attenuating) hop, any unmet caveat, or any bound
 * overrun yields a rejection with a specific reason. It never over-grants on an
 * unparsed glob.
 */
import { applyOps, impliedEffects } from "./algebra.js";
import { resolveSelector } from "./identity.js";
import type {
  AuthzDecision,
  Caveat,
  Cell,
  Did,
  Effect,
  EffectBounds,
  Grant,
  NodeIdent,
  NodeSelector,
  Op,
  State
} from "./types.js";

/** Effects that constitute a deletion and therefore require `allowDelete`. */
const DELETE_EFFECTS: ReadonlySet<Effect> = new Set<Effect>([
  "deletes_source",
  "deletes_test",
  "deletes_migration"
]);

const EFFECT_KINDS: ReadonlySet<Effect> = new Set<Effect>([
  "edits_source",
  "deletes_source",
  "moves_cell",
  "adds_dependency",
  "bumps_dependency_major",
  "bumps_dependency_minor",
  "removes_dependency",
  "adds_migration",
  "deletes_migration",
  "deletes_test",
  "skips_test",
  "changes_ci",
  "touches_sensitive_path",
  "adds_secret_like_value",
  "adds_generated_artifact"
]);

const TRANSFORM_TYPES: ReadonlySet<Op["op"] | "*"> = new Set<Op["op"] | "*">([
  "put_cell",
  "delete_cell",
  "move_cell",
  "patch_text",
  "*"
]);

interface GrantTemporalBounds {
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

interface CapabilityPath {
  readonly path: string;
  readonly opIndex: number;
  readonly role: "source" | "destination";
}

interface DerivedRequest {
  readonly paths: ReadonlyArray<CapabilityPath>;
  readonly uniquePaths: ReadonlySet<string>;
  readonly impliedEffects: ReadonlyArray<Effect>;
}

type DerivationResult =
  | { readonly ok: true; readonly request: DerivedRequest }
  | { readonly ok: false; readonly reason: string };

type TemporalCheck =
  | { readonly ok: true; readonly bounds: GrantTemporalBounds }
  | { readonly ok: false; readonly reason: string };

export interface AuthorizeInput {
  readonly chain: ReadonlyArray<Grant>;
  readonly actor: Did;
  readonly controller: Did;
  /** State against which the ordered operation sequence is evaluated. */
  readonly base: State;
  /** Concrete operations being authorized; no caller-provided footprint summary is trusted. */
  readonly ops: ReadonlyArray<Op>;
  readonly effects: ReadonlyArray<Effect>;
  readonly now?: Date | undefined;
}

/**
 * Authorize a request against a capability chain. Returns `{ ok: true }` only
 * when the chain roots at the controller, every hop attenuates (⊑) its parent,
 * and the leaf grant permits the exact ops/cells/effects requested at `now`.
 */
export function authorize(input: AuthorizeInput): AuthzDecision {
  try {
    const parsedInput = parseAuthorizeInput(input);
    if (!parsedInput.ok) {
      return deny(parsedInput.reason);
    }
    return authorizeValidated(parsedInput.value);
  } catch {
    return deny("authorization input is malformed");
  }
}

function authorizeValidated(input: AuthorizeInput): AuthzDecision {
  const { chain } = input;

  // (1) Non-empty chain rooted at the line controller.
  if (chain.length === 0) {
    return deny("empty grant chain");
  }
  const root = chain[0];
  if (root === undefined) {
    return deny("empty grant chain");
  }
  if (root.issuer !== input.controller) {
    return deny("root grant issuer does not match controller");
  }

  // All grants are evaluated against this one decision timestamp.
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return deny("evaluation timestamp is invalid"); // fail closed on a bad clock
  }

  const temporalBounds: GrantTemporalBounds[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const grant = chain[i];
    if (grant === undefined) {
      return deny(`grant chain has a hole at index ${i}`);
    }
    const temporal = checkTemporalConstraints(grant, i, nowMs);
    if (!temporal.ok) {
      return temporal;
    }
    temporalBounds.push(temporal.bounds);
  }

  // (2) Every hop must chain by DID and be an attenuation (⊑) of its parent.
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const parent = chain[i];
    const child = chain[i + 1];
    const parentTemporal = temporalBounds[i];
    const childTemporal = temporalBounds[i + 1];
    if (
      parent === undefined ||
      child === undefined ||
      parentTemporal === undefined ||
      childTemporal === undefined
    ) {
      return deny(`grant chain has a hole at hop ${i + 1}`);
    }
    if (child.issuer !== parent.audience) {
      return deny(`grant chain broken at hop ${i + 1}: issuer does not match parent audience`);
    }
    const attenuation = checkAttenuation(parent, child, parentTemporal, childTemporal, i + 1);
    if (!attenuation.ok) {
      return attenuation;
    }
  }

  // (3) The leaf grant is checked against the concrete request.
  const leaf = chain[chain.length - 1];
  if (leaf === undefined) {
    return deny("empty grant chain");
  }

  if (leaf.audience !== input.actor) {
    return deny("leaf grant audience does not match actor");
  }

  if (hasDuplicates(input.effects)) {
    return deny("effects contains a duplicate effect");
  }

  const derivation = deriveRequest(input.base, input.ops);
  if (!derivation.ok) {
    return derivation;
  }
  const derived = derivation.request;

  // Every actual operation must be permitted by the leaf (a "*" leaf permits all).
  if (!leaf.transformTypes.includes("*")) {
    const permittedOps = new Set<Op["op"] | "*">(leaf.transformTypes);
    for (let index = 0; index < input.ops.length; index += 1) {
      const op = input.ops[index];
      if (op === undefined) {
        return deny(`operation sequence has a hole at index ${index}`);
      }
      if (!permittedOps.has(op.op)) {
        return deny(`operation ${index} is not permitted by leaf grant: ${op.op}`);
      }
    }
  }

  // Sources and destinations are independent capability checks. Keep duplicate
  // path entries here so, for example, both sides of a move are checked even
  // though the budget below counts each concrete path only once.
  for (const touched of derived.paths) {
    const covered = leaf.cellSelectors.some((selector) => matchPath(selector, touched.path));
    if (!covered) {
      return deny(
        `operation ${touched.opIndex} ${touched.role} path is not covered by any leaf selector: ${touched.path}`
      );
    }
  }

  if (derived.uniquePaths.size > leaf.effectBounds.maxCellsTouched) {
    return deny(
      `unique touched paths (${derived.uniquePaths.size}) exceeds maxCellsTouched (${leaf.effectBounds.maxCellsTouched})`
    );
  }

  const declaredEffects = new Set<Effect>(input.effects);
  const allowedEffects = new Set<Effect>(leaf.effectBounds.allowedEffectKinds);

  // Delete and sensitive gates authorize both baseline effects and verified
  // over-declarations. This keeps extra effects visible rather than discarding
  // them merely because the concrete operations did not imply them.
  const hasDeleteEffect =
    derived.impliedEffects.some((effect) => DELETE_EFFECTS.has(effect)) ||
    input.effects.some((effect) => DELETE_EFFECTS.has(effect));
  if (hasDeleteEffect && !leaf.effectBounds.allowDelete) {
    return deny("delete operation or effect requires allowDelete on the leaf grant");
  }
  if (input.effects.includes("touches_sensitive_path") && !leaf.effectBounds.allowSensitive) {
    return deny("sensitive-path effect requires allowSensitive on the leaf grant");
  }

  for (const effect of input.effects) {
    if (!allowedEffects.has(effect)) {
      return deny(`effect is not permitted by leaf grant: ${effect}`);
    }
  }

  const missingEffects = derived.impliedEffects.filter((effect) => !declaredEffects.has(effect));
  if (missingEffects.length > 0) {
    return deny(`effect declaration is under-declared: missing ${missingEffects.join(", ")}`);
  }

  return { ok: true };
}

type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

type TrustedRecord = Readonly<Record<string, unknown>>;

function parseAuthorizeInput(value: unknown): ParseResult<AuthorizeInput> {
  const input = snapshotRecord(value, "authorization input", [
    "chain",
    "actor",
    "controller",
    "base",
    "ops",
    "effects",
    "now"
  ]);
  if (!input.ok) {
    return input;
  }

  const chain = snapshotArray(input.value["chain"], "grant chain", (grant, index) =>
    parseGrant(grant, index)
  );
  if (!chain.ok) {
    return chain;
  }

  const actor = input.value["actor"];
  if (typeof actor !== "string") {
    return parseFailure("authorization actor must be a string");
  }
  const controller = input.value["controller"];
  if (typeof controller !== "string") {
    return parseFailure("authorization controller must be a string");
  }

  const base = parseState(input.value["base"]);
  if (!base.ok) {
    return base;
  }
  const ops = snapshotArray(input.value["ops"], "operations", (op, index) => {
    const parsed = parseOperation(op, index);
    return parsed.ok ? parsed : parseFailure(`is invalid: ${parsed.reason}`);
  });
  if (!ops.ok) {
    return ops;
  }
  const effects = snapshotArray(input.value["effects"], "effects", (effect) => {
    if (!isEffect(effect)) {
      return parseFailure(`contains unknown effect ${formatUnknown(effect)}`);
    }
    return parseSuccess(effect);
  });
  if (!effects.ok) {
    return effects;
  }
  const now = parseDecisionTime(input.value["now"]);
  if (!now.ok) {
    return now;
  }

  return parseSuccess({
    chain: chain.value,
    actor: actor as Did,
    controller: controller as Did,
    base: base.value,
    ops: ops.value,
    effects: effects.value,
    ...(now.value === undefined ? {} : { now: now.value })
  });
}

function parseGrant(value: unknown, grantIndex: number): ParseResult<Grant> {
  const label = `grant ${grantIndex}`;
  const grant = snapshotRecord(value, label, [
    "issuer",
    "audience",
    "transformTypes",
    "cellSelectors",
    "effectBounds",
    "caveats",
    "expiry"
  ]);
  if (!grant.ok) {
    return grant;
  }

  const issuer = grant.value["issuer"];
  if (typeof issuer !== "string") {
    return parseFailure(`${label} issuer must be a string`);
  }
  const audience = grant.value["audience"];
  if (typeof audience !== "string") {
    return parseFailure(`${label} audience must be a string`);
  }

  const transformTypes = snapshotArray(
    grant.value["transformTypes"],
    `${label} transformTypes`,
    (transformType) => {
      if (!isTransformType(transformType)) {
        return parseFailure(`contains unknown transform type ${formatUnknown(transformType)}`);
      }
      return parseSuccess(transformType);
    }
  );
  if (!transformTypes.ok) {
    return transformTypes;
  }

  const cellSelectors = snapshotArray(
    grant.value["cellSelectors"],
    `${label} cellSelectors`,
    (selector) =>
      typeof selector === "string"
        ? parseSuccess(selector)
        : parseFailure("must contain only strings")
  );
  if (!cellSelectors.ok) {
    return cellSelectors;
  }

  const effectBounds = parseEffectBounds(grant.value["effectBounds"], label);
  if (!effectBounds.ok) {
    return effectBounds;
  }

  const caveatValue = grant.value["caveats"];
  let caveats: ReadonlyArray<Caveat> | undefined;
  if (caveatValue !== undefined) {
    const parsedCaveats = snapshotArray(caveatValue, `${label} caveats`, (caveat) =>
      parseCaveat(caveat)
    );
    if (!parsedCaveats.ok) {
      return parsedCaveats;
    }
    const caveatKeys = new Set<string>();
    for (let index = 0; index < parsedCaveats.value.length; index += 1) {
      const caveat = parsedCaveats.value[index];
      if (caveat === undefined) {
        return parseFailure(`${label} caveats has a hole at index ${index}`);
      }
      const key = caveatKey(caveat);
      if (caveatKeys.has(key)) {
        return parseFailure(`${label} caveats contains a duplicate caveat`);
      }
      caveatKeys.add(key);
    }
    caveats = parsedCaveats.value;
  }

  const expiry = grant.value["expiry"];
  if (expiry !== undefined && typeof expiry !== "string") {
    return parseFailure(`${label} expiry must be a string`);
  }

  return parseSuccess({
    issuer: issuer as Did,
    audience: audience as Did,
    transformTypes: transformTypes.value,
    cellSelectors: cellSelectors.value,
    effectBounds: effectBounds.value,
    ...(caveats === undefined ? {} : { caveats }),
    ...(expiry === undefined ? {} : { expiry })
  });
}

function parseEffectBounds(value: unknown, grantLabel: string): ParseResult<EffectBounds> {
  const bounds = snapshotRecord(value, `${grantLabel} effectBounds`, [
    "maxCellsTouched",
    "allowDelete",
    "allowSensitive",
    "allowedEffectKinds"
  ]);
  if (!bounds.ok) {
    return bounds;
  }

  const maxCellsTouched = bounds.value["maxCellsTouched"];
  if (!isNonNegativeSafeInteger(maxCellsTouched)) {
    return parseFailure(`${grantLabel} maxCellsTouched must be a non-negative safe integer`);
  }
  const allowDelete = bounds.value["allowDelete"];
  if (typeof allowDelete !== "boolean") {
    return parseFailure(`${grantLabel} allowDelete must be a boolean`);
  }
  const allowSensitive = bounds.value["allowSensitive"];
  if (typeof allowSensitive !== "boolean") {
    return parseFailure(`${grantLabel} allowSensitive must be a boolean`);
  }
  const allowedEffectKinds = snapshotArray(
    bounds.value["allowedEffectKinds"],
    `${grantLabel} allowedEffectKinds`,
    (effect) => {
      if (!isEffect(effect)) {
        return parseFailure(`contains unknown effect ${formatUnknown(effect)}`);
      }
      return parseSuccess(effect);
    }
  );
  if (!allowedEffectKinds.ok) {
    return allowedEffectKinds;
  }

  return parseSuccess({
    maxCellsTouched,
    allowDelete,
    allowSensitive,
    allowedEffectKinds: allowedEffectKinds.value
  });
}

function parseCaveat(value: unknown): ParseResult<Caveat> {
  const caveat = snapshotRecord(value, "caveat", ["kind", "iso"]);
  if (!caveat.ok) {
    return caveat;
  }
  const kind = caveat.value["kind"];
  if (kind !== "not_before" && kind !== "not_after") {
    return parseFailure(`contains unknown caveat kind ${formatUnknown(kind)}`);
  }
  const iso = caveat.value["iso"];
  if (typeof iso !== "string") {
    return parseFailure(`caveat ${kind} iso must be a string`);
  }
  return parseSuccess({ kind, iso });
}

function parseState(value: unknown): ParseResult<State> {
  const state = snapshotRecord(value, "authorization base", ["kind", "cells"]);
  if (!state.ok) {
    return state;
  }
  if (state.value["kind"] !== "state") {
    return parseFailure("authorization base must have kind state");
  }

  const rawCells = snapshotRecord(state.value["cells"], "authorization base cells");
  if (!rawCells.ok) {
    return rawCells;
  }
  const cells = Object.create(null) as Record<string, Cell>;
  for (const path of Object.keys(rawCells.value)) {
    const cell = parseCell(rawCells.value[path], path);
    if (!cell.ok) {
      return cell;
    }
    cells[path] = cell.value;
  }
  return parseSuccess({ kind: "state", cells });
}

function parseCell(value: unknown, path: string): ParseResult<Cell> {
  const label = `authorization base cell ${JSON.stringify(path)}`;
  const cell = snapshotRecord(value, label, ["facet", "ident", "text", "mode"]);
  if (!cell.ok) {
    return cell;
  }
  const facet = cell.value["facet"];
  if (facet !== "text" && facet !== "bytes") {
    return parseFailure(`${label} has unknown facet ${formatUnknown(facet)}`);
  }
  const ident = cell.value["ident"];
  if (typeof ident !== "string") {
    return parseFailure(`${label} ident must be a string`);
  }
  const text = cell.value["text"];
  if (typeof text !== "string") {
    return parseFailure(`${label} text must be a string`);
  }
  const mode = cell.value["mode"];
  if (mode !== undefined && !isNonNegativeSafeInteger(mode)) {
    return parseFailure(`${label} mode must be a non-negative safe integer`);
  }

  return parseSuccess({
    facet,
    ident: ident as NodeIdent,
    text,
    ...(mode === undefined ? {} : { mode })
  });
}

function parseOperation(value: unknown, index: number): ParseResult<Op> {
  const label = `operation ${index}`;
  const operation = snapshotRecord(value, label, [
    "op",
    "at",
    "ident",
    "facet",
    "text",
    "mode",
    "sel",
    "range",
    "to"
  ]);
  if (!operation.ok) {
    return operation;
  }
  const op = operation.value["op"];

  switch (op) {
    case "put_cell": {
      const fieldError = unexpectedRecordField(operation.value, [
        "op",
        "at",
        "ident",
        "facet",
        "text",
        "mode"
      ]);
      if (fieldError !== undefined) {
        return parseFailure(`${label} ${fieldError}`);
      }
      const at = operation.value["at"];
      if (typeof at !== "string") {
        return parseFailure(`${label} put_cell destination is missing`);
      }
      const ident = operation.value["ident"];
      if (typeof ident !== "string") {
        return parseFailure(`${label} put_cell ident must be a string`);
      }
      const facet = operation.value["facet"];
      if (facet !== "text" && facet !== "bytes") {
        return parseFailure(`${label} put_cell has unknown facet ${formatUnknown(facet)}`);
      }
      const text = operation.value["text"];
      if (typeof text !== "string") {
        return parseFailure(`${label} put_cell text must be a string`);
      }
      const mode = operation.value["mode"];
      if (mode !== undefined && !isNonNegativeSafeInteger(mode)) {
        return parseFailure(`${label} put_cell mode must be a non-negative safe integer`);
      }
      return parseSuccess({
        op,
        at,
        ident: ident as NodeIdent,
        facet,
        text,
        ...(mode === undefined ? {} : { mode })
      });
    }
    case "delete_cell": {
      const fieldError = unexpectedRecordField(operation.value, ["op", "sel"]);
      if (fieldError !== undefined) {
        return parseFailure(`${label} ${fieldError}`);
      }
      const selector = parseSelector(operation.value["sel"], label);
      return selector.ok ? parseSuccess({ op, sel: selector.value }) : selector;
    }
    case "move_cell": {
      const fieldError = unexpectedRecordField(operation.value, ["op", "sel", "to"]);
      if (fieldError !== undefined) {
        return parseFailure(`${label} ${fieldError}`);
      }
      const selector = parseSelector(operation.value["sel"], label);
      if (!selector.ok) {
        return selector;
      }
      const to = operation.value["to"];
      if (typeof to !== "string") {
        return parseFailure(`${label} move_cell destination is missing`);
      }
      return parseSuccess({ op, sel: selector.value, to });
    }
    case "patch_text": {
      const fieldError = unexpectedRecordField(operation.value, ["op", "sel", "range", "text"]);
      if (fieldError !== undefined) {
        return parseFailure(`${label} ${fieldError}`);
      }
      const selector = parseSelector(operation.value["sel"], label);
      if (!selector.ok) {
        return selector;
      }
      const range = snapshotArray(operation.value["range"], `${label} patch_text range`, (part) =>
        Number.isSafeInteger(part)
          ? parseSuccess(part as number)
          : parseFailure("must contain only safe integers")
      );
      if (!range.ok) {
        return range;
      }
      const start = range.value[0];
      const end = range.value[1];
      if (range.value.length !== 2 || start === undefined || end === undefined) {
        return parseFailure(`${label} patch_text range must contain exactly two safe integers`);
      }
      const text = operation.value["text"];
      if (typeof text !== "string") {
        return parseFailure(`${label} patch_text text must be a string`);
      }
      return parseSuccess({ op, sel: selector.value, range: [start, end], text });
    }
    default:
      return parseFailure(`${label} has unknown operation kind ${formatUnknown(op)}`);
  }
}

function parseSelector(value: unknown, operationLabel: string): ParseResult<NodeSelector> {
  const selector = snapshotRecord(value, `${operationLabel} selector`, ["path", "nid"]);
  if (!selector.ok) {
    return selector;
  }
  const hasPath = Object.hasOwn(selector.value, "path");
  const hasNid = Object.hasOwn(selector.value, "nid");
  if (hasPath === hasNid) {
    return parseFailure(`${operationLabel} selector must contain exactly one of path or nid`);
  }
  if (hasPath) {
    const path = selector.value["path"];
    return typeof path === "string"
      ? parseSuccess({ path })
      : parseFailure(`${operationLabel} selector path must be a string`);
  }
  const nid = selector.value["nid"];
  return typeof nid === "string"
    ? parseSuccess({ nid: nid as NodeIdent })
    : parseFailure(`${operationLabel} selector nid must be a string`);
}

function parseDecisionTime(value: unknown): ParseResult<Date | undefined> {
  if (value === undefined) {
    return parseSuccess(undefined);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Date.prototype
  ) {
    return parseFailure("authorization timestamp must be a Date");
  }
  if (Reflect.ownKeys(value).length !== 0) {
    return parseFailure("authorization timestamp must not contain custom properties");
  }
  const time = Date.prototype.getTime.call(value);
  if (!Number.isFinite(time)) {
    return parseFailure("evaluation timestamp is invalid");
  }
  return parseSuccess(new Date(time));
}

/**
 * Snapshot a caller-owned record without invoking any of its getters. Only
 * ordinary/null prototypes and enumerable data fields are accepted. The
 * returned null-prototype object is trusted and never aliases caller storage.
 */
function snapshotRecord(
  value: unknown,
  label: string,
  allowedKeys?: ReadonlyArray<string>
): ParseResult<TrustedRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return parseFailure(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return parseFailure(`${label} must have an ordinary or null prototype`);
  }

  const allowed = allowedKeys === undefined ? undefined : new Set(allowedKeys);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return parseFailure(`${label} must not contain symbol properties`);
    }
    if (allowed !== undefined && !allowed.has(key)) {
      return parseFailure(`${label} contains unexpected property ${JSON.stringify(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return parseFailure(`${label} changed while it was being parsed`);
    }
    if (!("value" in descriptor)) {
      return parseFailure(`${label}.${key} must be a data property, not an accessor`);
    }
    if (!descriptor.enumerable) {
      return parseFailure(`${label}.${key} must be enumerable`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return parseSuccess(snapshot);
}

/** Copy a canonical caller-owned array by own numeric descriptors only. */
function snapshotArray<T>(
  value: unknown,
  label: string,
  parseItem: (item: unknown, index: number) => ParseResult<T>
): ParseResult<ReadonlyArray<T>> {
  if (!Array.isArray(value)) {
    return parseFailure(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return parseFailure(`${label} must use the standard Array prototype`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 0xffff_ffff
  ) {
    return parseFailure(`${label} has an invalid length`);
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  const indexes = new Set<number>();
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      return parseFailure(`${label} must not contain symbol properties`);
    }
    const index = canonicalArrayIndex(key);
    if (index === undefined || index >= length) {
      return parseFailure(`${label} contains unexpected property ${JSON.stringify(key)}`);
    }
    indexes.add(index);
  }
  if (indexes.size !== length || keys.length !== length + 1) {
    return parseFailure(`${label} must be dense and contain only numeric entries`);
  }

  const snapshot = new Array<T>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      return parseFailure(`${label} has a hole at index ${index}`);
    }
    if (!("value" in descriptor)) {
      return parseFailure(`${label}[${index}] must be a data property, not an accessor`);
    }
    if (!descriptor.enumerable) {
      return parseFailure(`${label}[${index}] must be enumerable`);
    }
    const parsed = parseItem(descriptor.value, index);
    if (!parsed.ok) {
      return parseFailure(`${label}[${index}] ${parsed.reason}`);
    }
    snapshot[index] = parsed.value;
  }
  return parseSuccess(snapshot);
}

function canonicalArrayIndex(key: string): number | undefined {
  if (key === "0") {
    return 0;
  }
  if (!/^[1-9][0-9]*$/u.test(key)) {
    return undefined;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index < 0xffff_ffff && String(index) === key
    ? index
    : undefined;
}

function unexpectedRecordField(
  record: TrustedRecord,
  allowedKeys: ReadonlyArray<string>
): string | undefined {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return `contains unexpected property ${JSON.stringify(key)}`;
    }
  }
  return undefined;
}

function parseSuccess<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function parseFailure(reason: string): ParseResult<never> {
  return { ok: false, reason };
}

function isEffect(value: unknown): value is Effect {
  return typeof value === "string" && EFFECT_KINDS.has(value as Effect);
}

function isTransformType(value: unknown): value is Op["op"] | "*" {
  return typeof value === "string" && TRANSFORM_TYPES.has(value as Op["op"] | "*");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function formatUnknown(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
    case "symbol":
      return String(value);
    case "function":
      return "<function>";
    case "object":
      return "<object>";
  }
  return "<unknown>";
}

/**
 * Derive the capability-relevant request from concrete operations. Each op is
 * applied to the state produced by its predecessors, so stable-identity
 * selectors resolve at their current path after moves. `applyOps` remains the
 * source of truth for preconditions and identity integrity.
 */
function deriveRequest(base: State, ops: ReadonlyArray<Op>): DerivationResult {
  let current: State;
  try {
    const validatedBase = applyOps(base, []);
    if (!validatedBase.ok) {
      return deny(`base state is invalid: ${validatedBase.error.detail}`);
    }
    current = validatedBase.state;
  } catch (error) {
    return deny(`base state is invalid: ${errorDetail(error)}`);
  }

  const paths: CapabilityPath[] = [];
  const uniquePaths = new Set<string>();
  const effects = new Set<Effect>();

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === undefined) {
      return deny(`operation sequence has a hole at index ${index}`);
    }

    let next: State;
    try {
      const applied = applyOps(current, [op]);
      if (!applied.ok) {
        return deny(`operation ${index} failed precondition: ${applied.error.detail}`);
      }
      next = applied.state;
    } catch (error) {
      return deny(`operation ${index} failed precondition: ${errorDetail(error)}`);
    }

    const addPath = (path: string, role: CapabilityPath["role"]): void => {
      paths.push({ path, opIndex: index, role });
      uniquePaths.add(path);
    };

    try {
      switch (op.op) {
        case "put_cell":
          addPath(op.at, "destination");
          break;
        case "delete_cell":
        case "patch_text": {
          const found = resolveSelector(current, op.sel);
          if (found === undefined) {
            return deny(`operation ${index} failed precondition: selector does not resolve`);
          }
          addPath(found.path, "source");
          break;
        }
        case "move_cell": {
          const found = resolveSelector(current, op.sel);
          if (found === undefined) {
            return deny(`operation ${index} failed precondition: selector does not resolve`);
          }
          addPath(found.path, "source");
          addPath(op.to, "destination");
          break;
        }
        default: {
          const never: never = op;
          return deny(`operation ${index} has unknown kind: ${JSON.stringify(never)}`);
        }
      }

      for (const effect of impliedEffects(current, [op])) {
        effects.add(effect);
      }
    } catch (error) {
      return deny(`operation ${index} failed precondition: ${errorDetail(error)}`);
    }

    current = next;
  }

  return {
    ok: true,
    request: { paths, uniquePaths, impliedEffects: [...effects] }
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown operation error";
}

/**
 * Parse and validate one grant's half-open temporal interval. `not_before` is
 * inclusive; `expiry` and `not_after` are exclusive.
 */
function checkTemporalConstraints(grant: Grant, index: number, nowMs: number): TemporalCheck {
  let expiryMs = Number.POSITIVE_INFINITY;
  if (grant.expiry !== undefined) {
    expiryMs = Date.parse(grant.expiry);
    if (Number.isNaN(expiryMs)) {
      return deny(`grant ${index} expiry is not a valid timestamp`);
    }
  }

  let notBeforeMs = Number.NEGATIVE_INFINITY;
  let notAfterMs = Number.POSITIVE_INFINITY;
  const parsedCaveats: Array<{
    readonly kind: "not_after" | "not_before";
    readonly ms: number;
  }> = [];

  for (const caveat of grant.caveats ?? []) {
    const caveatMs = Date.parse(caveat.iso);
    if (Number.isNaN(caveatMs)) {
      return deny(`grant ${index} caveat ${caveat.kind} has an invalid timestamp`);
    }
    parsedCaveats.push({ kind: caveat.kind, ms: caveatMs });
    if (caveat.kind === "not_before") {
      notBeforeMs = Math.max(notBeforeMs, caveatMs);
    } else {
      notAfterMs = Math.min(notAfterMs, caveatMs);
    }
  }

  const effectiveNotAfterMs = Math.min(expiryMs, notAfterMs);
  if (notBeforeMs >= effectiveNotAfterMs) {
    return deny(`grant ${index} has a malformed temporal interval`);
  }

  if (nowMs >= expiryMs) {
    return deny(`grant ${index} is expired`);
  }
  for (const caveat of parsedCaveats) {
    if (caveat.kind === "not_after" && nowMs >= caveat.ms) {
      return deny(`grant ${index} caveat not_after is violated`);
    }
    if (caveat.kind === "not_before" && nowMs < caveat.ms) {
      return deny(`grant ${index} caveat not_before is violated`);
    }
  }

  return {
    ok: true,
    bounds: { notBeforeMs, notAfterMs: effectiveNotAfterMs }
  };
}

/**
 * Is `child` an attenuation (⊑) of `parent`? Attenuation only ever narrows:
 * transformTypes must be a subset (unless the parent is a "*" wildcard),
 * every child cellSelector must be covered by some parent selector, every
 * effect bound must be equal or tighter, and validity/caveats cannot widen.
 */
function checkAttenuation(
  parent: Grant,
  child: Grant,
  parentTemporal: GrantTemporalBounds,
  childTemporal: GrantTemporalBounds,
  hop: number
): AuthzDecision {
  // transformTypes: subset, unless the parent grants the "*" wildcard.
  if (!parent.transformTypes.includes("*")) {
    const parentOps = new Set<Op["op"] | "*">(parent.transformTypes);
    for (const transformType of child.transformTypes) {
      if (!parentOps.has(transformType)) {
        return deny(
          `attenuation violated at hop ${hop}: transformTypes widened (${transformType})`
        );
      }
    }
  }

  // cellSelectors: each child selector must be covered by some parent selector.
  for (const childSelector of child.cellSelectors) {
    const covered = parent.cellSelectors.some((parentSelector) =>
      covers(parentSelector, childSelector)
    );
    if (!covered) {
      return deny(
        `attenuation violated at hop ${hop}: cellSelector not covered by parent (${childSelector})`
      );
    }
  }

  // effectBounds: every dimension must be equal or tighter than the parent.
  const parentBounds = parent.effectBounds;
  const childBounds = child.effectBounds;
  if (childBounds.maxCellsTouched > parentBounds.maxCellsTouched) {
    return deny(`attenuation violated at hop ${hop}: maxCellsTouched widened`);
  }
  if (childBounds.allowDelete && !parentBounds.allowDelete) {
    return deny(`attenuation violated at hop ${hop}: allowDelete widened`);
  }
  if (childBounds.allowSensitive && !parentBounds.allowSensitive) {
    return deny(`attenuation violated at hop ${hop}: allowSensitive widened`);
  }
  const parentEffectKinds = new Set<Effect>(parentBounds.allowedEffectKinds);
  for (const kind of childBounds.allowedEffectKinds) {
    if (!parentEffectKinds.has(kind)) {
      return deny(`attenuation violated at hop ${hop}: allowedEffectKinds widened (${kind})`);
    }
  }

  // Caveats are retained byte-for-byte. A child may add recognized caveats,
  // but replacing one with a nominally narrower value is not decidable here.
  const childCaveats = new Set((child.caveats ?? []).map(caveatKey));
  for (const parentCaveat of parent.caveats ?? []) {
    if (!childCaveats.has(caveatKey(parentCaveat))) {
      return deny(`attenuation violated at hop ${hop}: parent caveat removed or altered`);
    }
  }

  if (childTemporal.notBeforeMs < parentTemporal.notBeforeMs) {
    return deny(`attenuation violated at hop ${hop}: child validity starts before parent`);
  }
  if (childTemporal.notAfterMs > parentTemporal.notAfterMs) {
    return deny(`attenuation violated at hop ${hop}: child validity outlives parent`);
  }

  return { ok: true };
}

/**
 * Match a concrete cell path against a single selector. Exactly three forms are
 * supported and everything else FAILS CLOSED (returns `false`) so authorization
 * never over-grants on an unparsed glob:
 *   - `"**"`         → matches every path
 *   - `"prefix/**"`  → matches any path strictly beneath `prefix/`
 *   - `"exact/path"` → matches only that path (no wildcard characters)
 * Any other use of `"*"` (e.g. `"src/*.ts"`, `"a*b"`, a `"*"` inside the prefix)
 * is undecidable here and returns `false`.
 */
function matchPath(selector: string, path: string): boolean {
  if (selector === "**") {
    return true;
  }
  if (selector.endsWith("/**")) {
    const prefix = selector.slice(0, selector.length - 3);
    if (prefix.includes("*")) {
      return false; // unsupported: a star inside the prefix
    }
    return path.startsWith(`${prefix}/`);
  }
  if (selector.includes("*")) {
    return false; // unsupported glob → fail closed
  }
  return selector === path; // exact
}

/**
 * Does a parent selector cover a child selector during attenuation? Coverage is
 * intentionally conservative (design §9.5): `"**"` covers all, identical
 * selectors cover each other, and `"p/**"` covers exact paths beneath `p/` and
 * narrower `"p/.../**"` globs. Any unsupported glob on either side fails closed.
 */
function covers(parent: string, child: string): boolean {
  if (parent === "**") {
    return true;
  }
  if (parent === child) {
    return true; // identical authority is a valid (non-widening) attenuation
  }
  if (parent.endsWith("/**")) {
    const parentPrefix = parent.slice(0, parent.length - 3);
    if (parentPrefix.includes("*")) {
      return false; // unsupported parent glob
    }
    if (child === "**") {
      return false; // child broader than parent
    }
    if (child.endsWith("/**")) {
      const childPrefix = child.slice(0, child.length - 3);
      if (childPrefix.includes("*")) {
        return false; // unsupported child glob
      }
      return childPrefix === parentPrefix || childPrefix.startsWith(`${parentPrefix}/`);
    }
    if (child.includes("*")) {
      return false; // unsupported child glob → fail closed
    }
    return child.startsWith(`${parentPrefix}/`); // exact path beneath the prefix
  }
  // Parent is an exact path (or an unsupported glob): it only covers an
  // identical selector, which was already handled above.
  return false;
}

function caveatKey(caveat: NonNullable<Grant["caveats"]>[number]): string {
  return `${caveat.kind}\u0000${caveat.iso}`;
}

function hasDuplicates<T>(values: ReadonlyArray<T>): boolean {
  return new Set(values).size !== values.length;
}

function deny(reason: string): AuthzDecision & { readonly ok: false } {
  return { ok: false, reason };
}
