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
import type { AuthzDecision, Did, Effect, Grant, Op } from "./types.js";

/** Effects that constitute a deletion and therefore require `allowDelete`. */
const DELETE_EFFECTS: ReadonlySet<Effect> = new Set<Effect>([
  "deletes_source",
  "deletes_test",
  "deletes_migration"
]);

export interface AuthorizeInput {
  readonly chain: ReadonlyArray<Grant>;
  readonly actor: Did;
  readonly controller: Did;
  readonly requestedOps: ReadonlyArray<Op["op"]>;
  readonly cellsTouched: ReadonlyArray<string>;
  readonly effects: ReadonlyArray<Effect>;
  readonly now?: Date | undefined;
}

/**
 * Authorize a request against a capability chain. Returns `{ ok: true }` only
 * when the chain roots at the controller, every hop attenuates (⊑) its parent,
 * and the leaf grant permits the exact ops/cells/effects requested at `now`.
 */
export function authorize(input: AuthorizeInput): AuthzDecision {
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

  // (2) Every hop must chain by DID and be an attenuation (⊑) of its parent.
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const parent = chain[i];
    const child = chain[i + 1];
    if (parent === undefined || child === undefined) {
      return deny(`grant chain has a hole at hop ${i + 1}`);
    }
    if (child.issuer !== parent.audience) {
      return deny(`grant chain broken at hop ${i + 1}: issuer does not match parent audience`);
    }
    const attenuation = checkAttenuation(parent, child, i + 1);
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

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) {
    return deny("evaluation timestamp is invalid"); // fail closed on a bad clock
  }

  // Expiry.
  if (leaf.expiry !== undefined) {
    const expiryMs = Date.parse(leaf.expiry);
    if (Number.isNaN(expiryMs)) {
      return deny("leaf grant expiry is not a valid timestamp");
    }
    if (nowMs > expiryMs) {
      return deny("leaf grant is expired");
    }
  }

  // Caveats (time windows). Any unparseable timestamp fails closed.
  const caveats = leaf.caveats ?? [];
  for (const caveat of caveats) {
    const caveatMs = Date.parse(caveat.iso);
    if (Number.isNaN(caveatMs)) {
      return deny(`leaf grant caveat ${caveat.kind} has an invalid timestamp`);
    }
    if (caveat.kind === "not_after" && nowMs > caveatMs) {
      return deny("leaf grant caveat not_after is violated");
    }
    if (caveat.kind === "not_before" && nowMs < caveatMs) {
      return deny("leaf grant caveat not_before is violated");
    }
  }

  // Every requested op must be permitted by the leaf (a "*" leaf permits all).
  if (!leaf.transformTypes.includes("*")) {
    const permittedOps = new Set<Op["op"] | "*">(leaf.transformTypes);
    for (const op of input.requestedOps) {
      if (!permittedOps.has(op)) {
        return deny(`requested op is not permitted by leaf grant: ${op}`);
      }
    }
  }

  // Every touched cell must be covered by some leaf selector (fail closed).
  for (const path of input.cellsTouched) {
    const covered = leaf.cellSelectors.some((selector) => matchPath(selector, path));
    if (!covered) {
      return deny(`cell is not covered by any leaf selector: ${path}`);
    }
  }

  // Every declared effect must be within the leaf's allowed effect kinds.
  const allowedEffects = new Set<Effect>(leaf.effectBounds.allowedEffectKinds);
  for (const effect of input.effects) {
    if (!allowedEffects.has(effect)) {
      return deny(`effect is not permitted by leaf grant: ${effect}`);
    }
  }

  // Cell budget.
  if (input.cellsTouched.length > leaf.effectBounds.maxCellsTouched) {
    return deny(
      `cellsTouched (${input.cellsTouched.length}) exceeds maxCellsTouched (${leaf.effectBounds.maxCellsTouched})`
    );
  }

  // Delete gating.
  if (
    input.effects.some((effect) => DELETE_EFFECTS.has(effect)) &&
    !leaf.effectBounds.allowDelete
  ) {
    return deny("delete effect requires allowDelete on the leaf grant");
  }

  // Sensitive-path gating.
  if (input.effects.includes("touches_sensitive_path") && !leaf.effectBounds.allowSensitive) {
    return deny("sensitive-path effect requires allowSensitive on the leaf grant");
  }

  return { ok: true };
}

/**
 * Is `child` an attenuation (⊑) of `parent`? Attenuation only ever narrows:
 * transformTypes must be a subset (unless the parent is a "*" wildcard),
 * every child cellSelector must be covered by some parent selector, and every
 * effect bound must be equal or tighter.
 */
function checkAttenuation(parent: Grant, child: Grant, hop: number): AuthzDecision {
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

function deny(reason: string): AuthzDecision {
  return { ok: false, reason };
}
