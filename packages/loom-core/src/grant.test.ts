import { describe, expect, it } from "vitest";

import { authorize, type AuthorizeInput } from "./grant.js";
import type { Did, Effect, EffectBounds, Grant, NodeIdent, Op, State } from "./types.js";

const did = (value: string): Did => value as Did;
const nid = (value: string): NodeIdent => value as NodeIdent;

const CONTROLLER = did("did:loom:controller");
const MID = did("did:loom:intermediate");
const AGENT = did("did:loom:agent");

const ALL_EFFECTS: ReadonlyArray<Effect> = [
  "edits_source",
  "deletes_source",
  "moves_cell",
  "touches_sensitive_path",
  "changes_ci",
  "skips_test",
  "deletes_test"
];

/** Broad root bounds so leaf/attenuation constraints are the variable under test. */
const broadBounds: EffectBounds = {
  maxCellsTouched: 100,
  allowDelete: true,
  allowSensitive: true,
  allowedEffectKinds: ALL_EFFECTS
};

function emptyState(): State {
  return { kind: "state", cells: Object.create(null) as State["cells"] };
}

function stateOf(...paths: ReadonlyArray<string>): State {
  const cells = Object.create(null) as Record<string, State["cells"][string]>;
  for (const path of paths) {
    cells[path] = { facet: "text", ident: nid(`nid:${path}`), text: "content" };
  }
  return { kind: "state", cells };
}

function put(at: string, ident: NodeIdent = nid(`nid:put:${at}`)): Op {
  return { op: "put_cell", at, ident, facet: "text", text: "content" };
}

function patch(path: string): Op {
  return { op: "patch_text", sel: { path }, range: [0, 0], text: "updated " };
}

function remove(path: string): Op {
  return { op: "delete_cell", sel: { path } };
}

function request(
  chain: ReadonlyArray<Grant>,
  base: State,
  ops: ReadonlyArray<Op>,
  effects: ReadonlyArray<Effect>,
  now?: Date
): AuthorizeInput {
  return { chain, actor: AGENT, controller: CONTROLLER, base, ops, effects, now };
}

describe("authorize — chain rooting", () => {
  it("rejects when the root grant issuer is not the line controller", () => {
    const grant: Grant = {
      issuer: did("did:loom:not-the-controller"),
      audience: AGENT,
      transformTypes: ["*"],
      cellSelectors: ["**"],
      effectBounds: broadBounds
    };

    const decision = authorize(request([grant], emptyState(), [put("src/a.ts")], ["edits_source"]));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/controller/);
    }
  });
});

describe("authorize — multi-hop delegation", () => {
  it("permits a valid attenuating two-hop chain", () => {
    const root: Grant = {
      issuer: CONTROLLER,
      audience: MID,
      transformTypes: ["*"],
      cellSelectors: ["**"],
      effectBounds: broadBounds
    };
    const leaf: Grant = {
      issuer: MID,
      audience: AGENT,
      transformTypes: ["put_cell", "patch_text"],
      cellSelectors: ["src/**"],
      effectBounds: {
        maxCellsTouched: 10,
        allowDelete: false,
        allowSensitive: false,
        allowedEffectKinds: ["edits_source"]
      }
    };

    expect(
      authorize(
        request(
          [root, leaf],
          stateOf("src/app/b.ts"),
          [put("src/app/a.ts"), patch("src/app/b.ts")],
          ["edits_source"]
        )
      )
    ).toEqual({ ok: true });
  });
});

describe("authorize — non-attenuating children are rejected", () => {
  const requestBase = {
    actor: AGENT,
    controller: CONTROLLER,
    base: emptyState(),
    ops: [put("src/a.ts")],
    effects: ["edits_source"] as const
  };

  it("rejects a child that widens transformTypes", () => {
    const root: Grant = {
      issuer: CONTROLLER,
      audience: MID,
      transformTypes: ["put_cell"],
      cellSelectors: ["**"],
      effectBounds: broadBounds
    };
    const leaf: Grant = {
      issuer: MID,
      audience: AGENT,
      transformTypes: ["put_cell", "delete_cell"],
      cellSelectors: ["**"],
      effectBounds: broadBounds
    };

    const decision = authorize({ chain: [root, leaf], ...requestBase });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/transformTypes/);
    }
  });

  it("rejects a child that widens allowed effect kinds", () => {
    const root: Grant = {
      issuer: CONTROLLER,
      audience: MID,
      transformTypes: ["*"],
      cellSelectors: ["**"],
      effectBounds: {
        maxCellsTouched: 10,
        allowDelete: true,
        allowSensitive: true,
        allowedEffectKinds: ["edits_source"]
      }
    };
    const leaf: Grant = {
      issuer: MID,
      audience: AGENT,
      transformTypes: ["*"],
      cellSelectors: ["**"],
      effectBounds: {
        maxCellsTouched: 10,
        allowDelete: true,
        allowSensitive: true,
        allowedEffectKinds: ["edits_source", "deletes_source"]
      }
    };

    const decision = authorize({ chain: [root, leaf], ...requestBase });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/allowedEffectKinds/);
    }
  });

  it("rejects a child that widens cell selectors", () => {
    const root: Grant = {
      issuer: CONTROLLER,
      audience: MID,
      transformTypes: ["*"],
      cellSelectors: ["src/billing/**"],
      effectBounds: broadBounds
    };
    const leaf: Grant = {
      issuer: MID,
      audience: AGENT,
      transformTypes: ["*"],
      cellSelectors: ["src/**"],
      effectBounds: broadBounds
    };

    const decision = authorize({ chain: [root, leaf], ...requestBase });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/cellSelector/);
    }
  });
});

describe("authorize — leaf operation and path selectors", () => {
  const singleGrant = (
    cellSelectors: ReadonlyArray<string>,
    transformTypes: Grant["transformTypes"] = ["*"]
  ): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes,
    cellSelectors,
    effectBounds: broadBounds
  });

  it("covers concrete paths beneath a 'p/**' selector and rejects paths outside it", () => {
    const grant = singleGrant(["src/billing/**"]);
    expect(
      authorize(
        request(
          [grant],
          stateOf("src/billing/charge.ts"),
          [patch("src/billing/charge.ts")],
          ["edits_source"]
        )
      )
    ).toEqual({ ok: true });

    const outside = authorize(
      request([grant], stateOf("src/other/x.ts"), [patch("src/other/x.ts")], ["edits_source"])
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.reason).toMatch(/not covered/);
    }
  });

  it("fails closed on an unsupported glob selector", () => {
    const grant = singleGrant(["src/*.ts"]);
    const decision = authorize(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/not covered/);
    }
  });

  it("checks actual leaf operation kinds rather than a caller summary", () => {
    const grant = singleGrant(["src/**"], ["put_cell"]);
    const decision = authorize(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/operation 0.*patch_text/);
    }
  });

  it("rejects an allowed move source when its destination is denied", () => {
    const grant = singleGrant(["src/allowed/**"], ["move_cell"]);
    const decision = authorize(
      request(
        [grant],
        stateOf("src/allowed/a.ts"),
        [{ op: "move_cell", sel: { path: "src/allowed/a.ts" }, to: "src/denied/a.ts" }],
        ["moves_cell"]
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/destination path.*src\/denied\/a\.ts/);
    }
  });
});

describe("authorize — expiry and caveats", () => {
  const leafWith = (extra: Pick<Grant, "expiry" | "caveats">): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["*"],
    cellSelectors: ["**"],
    effectBounds: broadBounds,
    ...extra
  });

  const timedRequest = (grant: Grant, now: Date): AuthorizeInput =>
    request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now);

  it("rejects an expired grant", () => {
    const decision = authorize(
      timedRequest(
        leafWith({ expiry: "2020-01-01T00:00:00.000Z" }),
        new Date("2026-01-01T00:00:00.000Z")
      )
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/expired/);
    }
  });

  it("rejects when a not_after caveat is violated", () => {
    const decision = authorize(
      timedRequest(
        leafWith({ caveats: [{ kind: "not_after", iso: "2020-01-01T00:00:00.000Z" }] }),
        new Date("2026-01-01T00:00:00.000Z")
      )
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/not_after/);
    }
  });

  it("rejects when a not_before caveat is violated", () => {
    const decision = authorize(
      timedRequest(
        leafWith({ caveats: [{ kind: "not_before", iso: "2030-01-01T00:00:00.000Z" }] }),
        new Date("2026-01-01T00:00:00.000Z")
      )
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/not_before/);
    }
  });

  it("permits a grant inside its validity window", () => {
    const grant = leafWith({
      expiry: "2030-01-01T00:00:00.000Z",
      caveats: [
        { kind: "not_before", iso: "2020-01-01T00:00:00.000Z" },
        { kind: "not_after", iso: "2030-01-01T00:00:00.000Z" }
      ]
    });
    expect(authorize(timedRequest(grant, new Date("2026-01-01T00:00:00.000Z")))).toEqual({
      ok: true
    });
  });
});

describe("authorize — effect gating", () => {
  const deleteLeaf = (allowDelete: boolean): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["delete_cell"],
    cellSelectors: ["**"],
    effectBounds: {
      maxCellsTouched: 10,
      allowDelete,
      allowSensitive: false,
      allowedEffectKinds: ["deletes_source"]
    }
  });

  const sensitiveLeaf = (allowSensitive: boolean): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["patch_text"],
    cellSelectors: ["**"],
    effectBounds: {
      maxCellsTouched: 10,
      allowDelete: false,
      allowSensitive,
      allowedEffectKinds: ["edits_source", "touches_sensitive_path"]
    }
  });

  it("blocks a derived delete effect unless allowDelete is set", () => {
    const denied = authorize(
      request([deleteLeaf(false)], stateOf("src/a.ts"), [remove("src/a.ts")], ["deletes_source"])
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toMatch(/allowDelete/);
    }

    expect(
      authorize(
        request([deleteLeaf(true)], stateOf("src/a.ts"), [remove("src/a.ts")], ["deletes_source"])
      )
    ).toEqual({ ok: true });
  });

  it("blocks an over-declared sensitive effect unless allowSensitive is set", () => {
    const denied = authorize(
      request(
        [sensitiveLeaf(false)],
        stateOf("src/a.ts"),
        [patch("src/a.ts")],
        ["edits_source", "touches_sensitive_path"]
      )
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toMatch(/allowSensitive/);
    }

    expect(
      authorize(
        request(
          [sensitiveLeaf(true)],
          stateOf("src/a.ts"),
          [patch("src/a.ts")],
          ["edits_source", "touches_sensitive_path"]
        )
      )
    ).toEqual({ ok: true });
  });

  it("authorizes and checks an allowed over-declared effect", () => {
    const grant: Grant = {
      issuer: CONTROLLER,
      audience: AGENT,
      transformTypes: ["patch_text"],
      cellSelectors: ["src/**"],
      effectBounds: {
        maxCellsTouched: 1,
        allowDelete: false,
        allowSensitive: false,
        allowedEffectKinds: ["edits_source", "changes_ci"]
      }
    };

    expect(
      authorize(
        request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source", "changes_ci"])
      )
    ).toEqual({ ok: true });
  });
});

describe("authorize — unique touched-path budget", () => {
  const budgetLeaf = (
    maxCellsTouched: number,
    transformTypes: Grant["transformTypes"] = ["put_cell"]
  ): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes,
    cellSelectors: ["**"],
    effectBounds: {
      maxCellsTouched,
      allowDelete: false,
      allowSensitive: false,
      allowedEffectKinds: ["edits_source"]
    }
  });

  it("rejects when distinct derived paths exceed maxCellsTouched", () => {
    const decision = authorize(
      request([budgetLeaf(1)], emptyState(), [put("src/a.ts"), put("src/b.ts")], ["edits_source"])
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/unique touched paths.*maxCellsTouched/);
    }
  });

  it("counts repeated access to one path once", () => {
    expect(
      authorize(
        request(
          [budgetLeaf(1, ["patch_text"])],
          stateOf("src/a.ts"),
          [patch("src/a.ts"), patch("src/a.ts")],
          ["edits_source"]
        )
      )
    ).toEqual({ ok: true });
  });
});

describe("authorize — chain temporal attenuation", () => {
  const grant = (
    issuer: Did,
    audience: Did,
    extra: Pick<Grant, "expiry" | "caveats"> = {}
  ): Grant => ({
    issuer,
    audience,
    transformTypes: ["*"],
    cellSelectors: ["**"],
    effectBounds: broadBounds,
    ...extra
  });

  const chainRequest = (
    chain: ReadonlyArray<Grant>,
    now = new Date("2026-01-01T00:00:00.000Z")
  ): AuthorizeInput =>
    request(chain, stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now);

  it("rejects an expired parent even when the leaf has not expired", () => {
    const decision = authorize(
      chainRequest([
        grant(CONTROLLER, MID, { expiry: "2025-01-01T00:00:00.000Z" }),
        grant(MID, AGENT)
      ])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/grant 0.*expired/);
    }
  });

  it("rejects a not-yet-valid parent even when the leaf is valid", () => {
    const decision = authorize(
      chainRequest([
        grant(CONTROLLER, MID, {
          caveats: [{ kind: "not_before", iso: "2030-01-01T00:00:00.000Z" }]
        }),
        grant(MID, AGENT)
      ])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/grant 0.*not_before/);
    }
  });

  it("treats expiry and not_after as exclusive upper bounds", () => {
    const boundary = new Date("2030-01-01T00:00:00.000Z");
    const atExpiry = authorize(
      chainRequest([grant(CONTROLLER, AGENT, { expiry: boundary.toISOString() })], boundary)
    );
    const atNotAfter = authorize(
      chainRequest(
        [
          grant(CONTROLLER, AGENT, {
            caveats: [{ kind: "not_after", iso: boundary.toISOString() }]
          })
        ],
        boundary
      )
    );

    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) {
      expect(atExpiry.reason).toMatch(/expired/);
    }
    expect(atNotAfter.ok).toBe(false);
    if (!atNotAfter.ok) {
      expect(atNotAfter.reason).toMatch(/not_after/);
    }
  });

  it("rejects an empty temporal interval", () => {
    const boundary = "2030-01-01T00:00:00.000Z";
    const decision = authorize(
      chainRequest(
        [
          grant(CONTROLLER, AGENT, {
            caveats: [
              { kind: "not_before", iso: boundary },
              { kind: "not_after", iso: boundary }
            ]
          })
        ],
        new Date(boundary)
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/malformed temporal interval/);
    }
  });

  it("rejects a child whose validity outlives its parent", () => {
    const decision = authorize(
      chainRequest([
        grant(CONTROLLER, MID, { expiry: "2030-01-01T00:00:00.000Z" }),
        grant(MID, AGENT, { expiry: "2031-01-01T00:00:00.000Z" })
      ])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/validity outlives parent/);
    }
  });

  it("rejects a child that removes a parent caveat even when otherwise narrower", () => {
    const decision = authorize(
      chainRequest([
        grant(CONTROLLER, MID, {
          caveats: [{ kind: "not_after", iso: "2030-01-01T00:00:00.000Z" }]
        }),
        grant(MID, AGENT, { expiry: "2029-01-01T00:00:00.000Z" })
      ])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/parent caveat removed or altered/);
    }
  });

  it("rejects a child that starts before its parent by widening a caveat", () => {
    const decision = authorize(
      chainRequest([
        grant(CONTROLLER, MID, {
          caveats: [{ kind: "not_before", iso: "2025-01-01T00:00:00.000Z" }]
        }),
        grant(MID, AGENT, {
          caveats: [{ kind: "not_before", iso: "2020-01-01T00:00:00.000Z" }]
        })
      ])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/parent caveat removed or altered/);
    }
  });
});

describe("authorize — ordered operation derivation and preconditions", () => {
  const grantWith = (
    transformTypes: Grant["transformTypes"] = ["*"],
    overrides: Partial<EffectBounds> = {}
  ): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes,
    cellSelectors: ["**"],
    effectBounds: { ...broadBounds, ...overrides }
  });

  it("resolves a patch against the current path after an earlier move", () => {
    const movedNid = nid("nid:moved");
    const cells = Object.create(null) as Record<string, State["cells"][string]>;
    cells["src/old.ts"] = { facet: "text", ident: movedNid, text: "content" };
    const base: State = { kind: "state", cells };
    const grant: Grant = {
      issuer: CONTROLLER,
      audience: AGENT,
      transformTypes: ["move_cell", "patch_text"],
      cellSelectors: ["src/old.ts", "src/new.ts"],
      effectBounds: {
        maxCellsTouched: 2,
        allowDelete: false,
        allowSensitive: false,
        allowedEffectKinds: ["moves_cell", "edits_source"]
      }
    };

    expect(
      authorize(
        request(
          [grant],
          base,
          [
            { op: "move_cell", sel: { nid: movedNid }, to: "src/new.ts" },
            { op: "patch_text", sel: { nid: movedNid }, range: [0, 0], text: "updated " }
          ],
          ["moves_cell", "edits_source"]
        )
      )
    ).toEqual({ ok: true });
  });

  it("rejects an omitted implied delete effect", () => {
    const decision = authorize(
      request(
        [grantWith(["delete_cell"], { allowDelete: true })],
        stateOf("src/a.ts"),
        [remove("src/a.ts")],
        []
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/under-declared.*deletes_source/);
    }
  });

  it("requires allowDelete from the derived delete even when its effect is omitted", () => {
    const decision = authorize(
      request(
        [
          grantWith(["delete_cell"], {
            allowDelete: false,
            allowedEffectKinds: []
          })
        ],
        stateOf("src/a.ts"),
        [remove("src/a.ts")],
        []
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/allowDelete/);
    }
  });

  it("derives path-specific delete effects from the current state", () => {
    const decision = authorize(
      request(
        [grantWith(["delete_cell"], { allowDelete: true })],
        stateOf("src/a.test.ts"),
        [remove("src/a.test.ts")],
        ["deletes_source"]
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/under-declared.*deletes_test/);
    }
  });

  it("rejects a selector that does not resolve", () => {
    const decision = authorize(
      request(
        [grantWith(["patch_text"])],
        emptyState(),
        [patch("src/missing.ts")],
        ["edits_source"]
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/operation 0 failed precondition.*selector does not resolve/);
    }
  });

  it("rejects a malformed selector rather than throwing", () => {
    const malformed = {
      op: "patch_text",
      sel: { path: "src/a.ts", nid: nid("nid:a") },
      range: [0, 0],
      text: "x"
    } as unknown as Op;
    const decision = authorize(
      request([grantWith(["patch_text"])], stateOf("src/a.ts"), [malformed], ["edits_source"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/invalid.*exactly one of path or nid/);
    }
  });

  it("rejects a move with an omitted destination", () => {
    const malformed = {
      op: "move_cell",
      sel: { path: "src/a.ts" }
    } as unknown as Op;
    const decision = authorize(
      request([grantWith(["move_cell"])], stateOf("src/a.ts"), [malformed], ["moves_cell"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/move_cell destination is missing/);
    }
  });

  it("rejects an occupied move destination", () => {
    const decision = authorize(
      request(
        [grantWith(["move_cell"])],
        stateOf("src/a.ts", "src/b.ts"),
        [{ op: "move_cell", sel: { path: "src/a.ts" }, to: "src/b.ts" }],
        ["moves_cell"]
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/failed precondition.*target path already occupied/);
    }
  });

  it("rejects a put that creates a NodeIdent collision", () => {
    const sharedNid = nid("nid:shared");
    const cells = Object.create(null) as Record<string, State["cells"][string]>;
    cells["src/a.ts"] = { facet: "text", ident: sharedNid, text: "a" };
    const base: State = { kind: "state", cells };
    const decision = authorize(
      request([grantWith(["put_cell"])], base, [put("src/b.ts", sharedNid)], ["edits_source"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/failed precondition.*duplicate NodeIdent/);
    }
  });

  it("rejects duplicate declared effects", () => {
    const decision = authorize(
      request(
        [grantWith(["patch_text"])],
        stateOf("src/a.ts"),
        [patch("src/a.ts")],
        ["edits_source", "edits_source"]
      )
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/duplicate effect/);
    }
  });
});

describe("authorize — identity replacement deletion authority", () => {
  const replacementGrant = (allowDelete: boolean): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["put_cell"],
    cellSelectors: ["src/**"],
    effectBounds: {
      maxCellsTouched: 1,
      allowDelete,
      allowSensitive: false,
      allowedEffectKinds: ["edits_source", "deletes_source"]
    }
  });
  const replacement: Op = {
    op: "put_cell",
    at: "src/a.ts",
    ident: nid("nid:replacement"),
    facet: "text",
    text: "replacement"
  };

  it("requires allowDelete even when the caller omits the derived deletion effect", () => {
    const decision = authorize(
      request([replacementGrant(false)], stateOf("src/a.ts"), [replacement], ["edits_source"])
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/allowDelete/);
    }
  });

  it("requires the identity deletion to be declared and permitted", () => {
    const underDeclared = authorize(
      request([replacementGrant(true)], stateOf("src/a.ts"), [replacement], ["edits_source"])
    );
    expect(underDeclared.ok).toBe(false);
    if (!underDeclared.ok) {
      expect(underDeclared.reason).toMatch(/under-declared.*deletes_source/);
    }

    expect(
      authorize(
        request(
          [replacementGrant(true)],
          stateOf("src/a.ts"),
          [replacement],
          ["edits_source", "deletes_source"]
        )
      )
    ).toEqual({ ok: true });
  });
});

describe("authorize — untrusted Grant runtime validation", () => {
  const validGrant: Grant = {
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["patch_text"],
    cellSelectors: ["src/**"],
    effectBounds: {
      maxCellsTouched: 1,
      allowDelete: false,
      allowSensitive: false,
      allowedEffectKinds: ["edits_source"]
    },
    caveats: [{ kind: "not_after", iso: "2030-01-01T00:00:00.000Z" }],
    expiry: "2030-01-01T00:00:00.000Z"
  };
  const validBounds = validGrant.effectBounds;
  const validRequest = request(
    [validGrant],
    stateOf("src/a.ts"),
    [patch("src/a.ts")],
    ["edits_source"],
    new Date("2026-01-01T00:00:00.000Z")
  );

  const malformedGrants: ReadonlyArray<readonly [string, unknown]> = [
    ["issuer", { ...validGrant, issuer: 42 }],
    ["audience", { ...validGrant, audience: null }],
    ["transformTypes array", { ...validGrant, transformTypes: "patch_text" }],
    ["transformTypes enum", { ...validGrant, transformTypes: ["shell_command"] }],
    ["cellSelectors array", { ...validGrant, cellSelectors: "src/**" }],
    ["cellSelectors item", { ...validGrant, cellSelectors: [42] }],
    ["effectBounds", { ...validGrant, effectBounds: null }],
    [
      "maxCellsTouched NaN",
      { ...validGrant, effectBounds: { ...validBounds, maxCellsTouched: Number.NaN } }
    ],
    [
      "maxCellsTouched negative",
      { ...validGrant, effectBounds: { ...validBounds, maxCellsTouched: -1 } }
    ],
    [
      "maxCellsTouched fractional",
      { ...validGrant, effectBounds: { ...validBounds, maxCellsTouched: 0.5 } }
    ],
    [
      "allowDelete boolean",
      { ...validGrant, effectBounds: { ...validBounds, allowDelete: "false" } }
    ],
    [
      "allowSensitive boolean",
      { ...validGrant, effectBounds: { ...validBounds, allowSensitive: 0 } }
    ],
    [
      "allowedEffectKinds array",
      { ...validGrant, effectBounds: { ...validBounds, allowedEffectKinds: "edits_source" } }
    ],
    [
      "allowedEffectKinds enum",
      { ...validGrant, effectBounds: { ...validBounds, allowedEffectKinds: ["runs_program"] } }
    ],
    ["caveats array", { ...validGrant, caveats: { kind: "not_after" } }],
    [
      "caveat discriminant",
      {
        ...validGrant,
        caveats: [{ kind: "unless_revoked", iso: "2030-01-01T00:00:00.000Z" }]
      }
    ],
    ["caveat timestamp type", { ...validGrant, caveats: [{ kind: "not_after", iso: 42 }] }],
    ["expiry type", { ...validGrant, expiry: 2030 }]
  ];

  it.each(malformedGrants)("rejects malformed %s without throwing", (_field, grant) => {
    const input = { ...validRequest, chain: [grant] } as unknown as AuthorizeInput;
    let decision: ReturnType<typeof authorize> | undefined;

    expect(() => {
      decision = authorize(input);
    }).not.toThrow();
    expect(decision?.ok).toBe(false);
    if (decision !== undefined && !decision.ok) {
      expect(decision.reason).toMatch(/grant|transform|effect|caveat|boolean|array|integer/iu);
    }
  });

  it("rejects duplicate caveats on a root Grant without throwing", () => {
    const duplicate = { kind: "not_after", iso: "2030-01-01T00:00:00.000Z" } as const;
    const input: AuthorizeInput = {
      ...validRequest,
      chain: [{ ...validGrant, caveats: [duplicate, { ...duplicate }] }]
    };
    let decision: ReturnType<typeof authorize> | undefined;

    expect(() => {
      decision = authorize(input);
    }).not.toThrow();
    expect(decision?.ok).toBe(false);
    if (decision !== undefined && !decision.ok) {
      expect(decision.reason).toMatch(/grant 0.*duplicate caveat/);
    }
  });

  it("rejects duplicate caveats on a delegated leaf Grant without throwing", () => {
    const duplicate = { kind: "not_before", iso: "2020-01-01T00:00:00.000Z" } as const;
    const root: Grant = { ...validGrant, audience: MID, caveats: [] };
    const leaf: Grant = {
      ...validGrant,
      issuer: MID,
      caveats: [duplicate, { ...duplicate }]
    };
    const input: AuthorizeInput = { ...validRequest, chain: [root, leaf] };
    let decision: ReturnType<typeof authorize> | undefined;

    expect(() => {
      decision = authorize(input);
    }).not.toThrow();
    expect(decision?.ok).toBe(false);
    if (decision !== undefined && !decision.ok) {
      expect(decision.reason).toMatch(/grant 1.*duplicate caveat/);
    }
  });

  it("preserves distinct recognized caveats", () => {
    const grant: Grant = {
      ...validGrant,
      caveats: [
        { kind: "not_before", iso: "2020-01-01T00:00:00.000Z" },
        { kind: "not_after", iso: "2030-01-01T00:00:00.000Z" }
      ]
    };

    expect(authorize({ ...validRequest, chain: [grant] })).toEqual({ ok: true });
  });

  it("rejects malformed request arrays and effect enums without throwing", () => {
    const malformedInputs: unknown[] = [
      { ...validRequest, chain: "not-an-array" },
      { ...validRequest, ops: "not-an-array" },
      { ...validRequest, effects: ["unknown_effect"] },
      { ...validRequest, now: "2026-01-01T00:00:00.000Z" }
    ];

    for (const input of malformedInputs) {
      expect(() => authorize(input as AuthorizeInput)).not.toThrow();
      expect(authorize(input as AuthorizeInput).ok).toBe(false);
    }
  });
});

describe("authorize — caller-owned behavior is never executed", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const baseGrant = (overrides: Partial<Grant> = {}): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["patch_text"],
    cellSelectors: ["src/**"],
    effectBounds: {
      maxCellsTouched: 2,
      allowDelete: false,
      allowSensitive: false,
      allowedEffectKinds: ["edits_source"]
    },
    ...overrides
  });

  function arrayWithOwnBehavior<T>(
    entries: ReadonlyArray<T>,
    property: PropertyKey,
    behavior: unknown
  ): ReadonlyArray<T> {
    const array = Array.from(entries);
    Object.defineProperty(array, property, {
      value: behavior,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return array;
  }

  function expectDeniedWithoutThrow(input: AuthorizeInput): ReturnType<typeof authorize> {
    let decision: ReturnType<typeof authorize> | undefined;
    expect(() => {
      decision = authorize(input);
    }).not.toThrow();
    if (decision === undefined) {
      throw new Error("authorize did not return a decision");
    }
    expect(decision.ok).toBe(false);
    return decision;
  }

  it("does not invoke a transformTypes includes override on a root Grant", () => {
    let calls = 0;
    const transformTypes = arrayWithOwnBehavior(["delete_cell"], "includes", () => {
      calls += 1;
      return true;
    });
    const grant = baseGrant({ transformTypes: transformTypes as Grant["transformTypes"] });

    const decision = expectDeniedWithoutThrow(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now)
    );

    expect(calls).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/transformTypes.*unexpected property.*includes/iu);
    }
  });

  it("does not invoke a cellSelectors some override to widen a root Grant", () => {
    let calls = 0;
    const cellSelectors = arrayWithOwnBehavior(["private/**"], "some", () => {
      calls += 1;
      return true;
    });
    const grant = baseGrant({ cellSelectors });

    const decision = expectDeniedWithoutThrow(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now)
    );

    expect(calls).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/cellSelectors.*unexpected property.*some/iu);
    }
  });

  it("does not invoke a caveat Symbol.iterator override to hide expiry", () => {
    let calls = 0;
    const caveats = arrayWithOwnBehavior(
      [{ kind: "not_after", iso: "2020-01-01T00:00:00.000Z" } as const],
      Symbol.iterator,
      function* hostileIterator() {
        calls += 1;
      }
    );
    const grant = baseGrant({ caveats });

    const decision = expectDeniedWithoutThrow(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now)
    );

    expect(calls).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/caveats.*symbol properties/iu);
    }
  });

  it("does not invoke a delegated caveat map override to counterfeit retention", () => {
    let calls = 0;
    const parentCaveat = { kind: "not_after", iso: "2030-01-01T00:00:00.000Z" } as const;
    const childCaveats = arrayWithOwnBehavior(
      [{ kind: "not_after", iso: "2029-01-01T00:00:00.000Z" } as const],
      "map",
      () => {
        calls += 1;
        return [`${parentCaveat.kind}\u0000${parentCaveat.iso}`];
      }
    );
    const root = baseGrant({ audience: MID, caveats: [parentCaveat] });
    const child = baseGrant({ issuer: MID, caveats: childCaveats });

    const decision = expectDeniedWithoutThrow(
      request([root, child], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now)
    );

    expect(calls).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/grant 1 caveats.*unexpected property.*map/iu);
    }
  });

  it("does not invoke an effects includes override to bypass sensitive gating", () => {
    let calls = 0;
    const effects = arrayWithOwnBehavior<Effect>(
      ["edits_source", "touches_sensitive_path"],
      "includes",
      () => {
        calls += 1;
        return false;
      }
    );
    const grant = baseGrant({
      effectBounds: {
        maxCellsTouched: 2,
        allowDelete: false,
        allowSensitive: false,
        allowedEffectKinds: ["edits_source", "touches_sensitive_path"]
      }
    });

    const decision = expectDeniedWithoutThrow(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], effects, now)
    );

    expect(calls).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/effects.*unexpected property.*includes/iu);
    }
  });

  it("rejects a changing root security-field accessor without reading it", () => {
    let reads = 0;
    const grant = baseGrant() as unknown as Record<string, unknown>;
    Object.defineProperty(grant, "transformTypes", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? ["delete_cell"] : ["*"];
      }
    });

    const decision = expectDeniedWithoutThrow(
      request(
        [grant as unknown as Grant],
        stateOf("src/a.ts"),
        [patch("src/a.ts")],
        ["edits_source"],
        now
      )
    );

    expect(reads).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/grant 0\.transformTypes.*accessor/iu);
    }
  });

  it("rejects a changing delegated security-field accessor without reading it", () => {
    let reads = 0;
    const root = baseGrant({ audience: MID, transformTypes: ["*"] });
    const child = baseGrant({ issuer: MID }) as unknown as Record<string, unknown>;
    Object.defineProperty(child, "transformTypes", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? ["delete_cell"] : ["*"];
      }
    });

    const decision = expectDeniedWithoutThrow(
      request(
        [root, child as unknown as Grant],
        stateOf("src/a.ts"),
        [patch("src/a.ts")],
        ["edits_source"],
        now
      )
    );

    expect(reads).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/grant 1\.transformTypes.*accessor/iu);
    }
  });

  it("rejects an accessor-backed array element without invoking it", () => {
    let reads = 0;
    const transformTypes = ["patch_text"] as Array<Grant["transformTypes"][number]>;
    Object.defineProperty(transformTypes, 0, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return "*";
      }
    });
    const grant = baseGrant({ transformTypes });

    const decision = expectDeniedWithoutThrow(
      request([grant], stateOf("src/a.ts"), [patch("src/a.ts")], ["edits_source"], now)
    );

    expect(reads).toBe(0);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/transformTypes\[0\].*accessor/iu);
    }
  });
});
