import { describe, expect, it } from "vitest";

import { authorize, type AuthorizeInput } from "./grant.js";
import type { Did, EffectBounds, Grant } from "./types.js";

const did = (value: string): Did => value as Did;

const CONTROLLER = did("did:loom:controller");
const MID = did("did:loom:intermediate");
const AGENT = did("did:loom:agent");

/** Broad root bounds so leaf/attenuation constraints are the variable under test. */
const broadBounds: EffectBounds = {
  maxCellsTouched: 100,
  allowDelete: true,
  allowSensitive: true,
  allowedEffectKinds: ["edits_source", "deletes_source", "moves_cell", "touches_sensitive_path"]
};

describe("authorize — chain rooting", () => {
  it("rejects when the root grant issuer is not the line controller", () => {
    const grant: Grant = {
      issuer: did("did:loom:not-the-controller"),
      audience: AGENT,
      transformTypes: ["*"],
      cellSelectors: ["**"],
      effectBounds: broadBounds
    };
    const input: AuthorizeInput = {
      chain: [grant],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["put_cell"],
      cellsTouched: ["src/a.ts"],
      effects: ["edits_source"]
    };

    const decision = authorize(input);
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
    const input: AuthorizeInput = {
      chain: [root, leaf],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["put_cell", "patch_text"],
      cellsTouched: ["src/app/a.ts", "src/app/b.ts"],
      effects: ["edits_source"]
    };

    expect(authorize(input)).toEqual({ ok: true });
  });
});

describe("authorize — non-attenuating children are rejected", () => {
  const requestBase = {
    actor: AGENT,
    controller: CONTROLLER,
    requestedOps: ["put_cell"] as const,
    cellsTouched: ["src/a.ts"],
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
      transformTypes: ["put_cell", "delete_cell"], // widened
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
        allowedEffectKinds: ["edits_source", "deletes_source"] // widened
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
      cellSelectors: ["src/**"], // broader than the parent's src/billing/**
      effectBounds: broadBounds
    };

    const decision = authorize({ chain: [root, leaf], ...requestBase });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/cellSelector/);
    }
  });
});

describe("authorize — cell selector coverage", () => {
  const singleGrant = (cellSelectors: ReadonlyArray<string>): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["*"],
    cellSelectors,
    effectBounds: broadBounds
  });

  it("covers concrete paths beneath a 'p/**' selector and rejects paths outside it", () => {
    const grant = singleGrant(["src/billing/**"]);
    const base = {
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["patch_text"] as const,
      effects: ["edits_source"] as const
    };

    expect(authorize({ chain: [grant], cellsTouched: ["src/billing/charge.ts"], ...base })).toEqual(
      {
        ok: true
      }
    );

    const outside = authorize({ chain: [grant], cellsTouched: ["src/other/x.ts"], ...base });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.reason).toMatch(/not covered/);
    }
  });

  it("fails closed on an unsupported glob selector", () => {
    const grant = singleGrant(["src/*.ts"]); // single-star glob is undecidable here
    const decision = authorize({
      chain: [grant],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["patch_text"],
      cellsTouched: ["src/a.ts"],
      effects: ["edits_source"]
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/not covered/);
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

  const request = (grant: Grant, now: Date): AuthorizeInput => ({
    chain: [grant],
    actor: AGENT,
    controller: CONTROLLER,
    requestedOps: ["patch_text"],
    cellsTouched: ["src/a.ts"],
    effects: ["edits_source"],
    now
  });

  it("rejects an expired grant", () => {
    const grant = leafWith({ expiry: "2020-01-01T00:00:00.000Z" });
    const decision = authorize(request(grant, new Date("2026-01-01T00:00:00.000Z")));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/expired/);
    }
  });

  it("rejects when a not_after caveat is violated", () => {
    const grant = leafWith({ caveats: [{ kind: "not_after", iso: "2020-01-01T00:00:00.000Z" }] });
    const decision = authorize(request(grant, new Date("2026-01-01T00:00:00.000Z")));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/not_after/);
    }
  });

  it("rejects when a not_before caveat is violated", () => {
    const grant = leafWith({ caveats: [{ kind: "not_before", iso: "2030-01-01T00:00:00.000Z" }] });
    const decision = authorize(request(grant, new Date("2026-01-01T00:00:00.000Z")));
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
    expect(authorize(request(grant, new Date("2026-01-01T00:00:00.000Z")))).toEqual({ ok: true });
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

  it("blocks a delete effect unless allowDelete is set", () => {
    const denied = authorize({
      chain: [deleteLeaf(false)],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["delete_cell"],
      cellsTouched: ["src/a.ts"],
      effects: ["deletes_source"]
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toMatch(/allowDelete/);
    }

    expect(
      authorize({
        chain: [deleteLeaf(true)],
        actor: AGENT,
        controller: CONTROLLER,
        requestedOps: ["delete_cell"],
        cellsTouched: ["src/a.ts"],
        effects: ["deletes_source"]
      })
    ).toEqual({ ok: true });
  });

  it("blocks a sensitive-path effect unless allowSensitive is set", () => {
    const denied = authorize({
      chain: [sensitiveLeaf(false)],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["patch_text"],
      cellsTouched: ["src/a.ts"],
      effects: ["edits_source", "touches_sensitive_path"]
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toMatch(/allowSensitive/);
    }

    expect(
      authorize({
        chain: [sensitiveLeaf(true)],
        actor: AGENT,
        controller: CONTROLLER,
        requestedOps: ["patch_text"],
        cellsTouched: ["src/a.ts"],
        effects: ["edits_source", "touches_sensitive_path"]
      })
    ).toEqual({ ok: true });
  });
});

describe("authorize — cell budget", () => {
  const budgetLeaf = (maxCellsTouched: number): Grant => ({
    issuer: CONTROLLER,
    audience: AGENT,
    transformTypes: ["put_cell"],
    cellSelectors: ["**"],
    effectBounds: {
      maxCellsTouched,
      allowDelete: false,
      allowSensitive: false,
      allowedEffectKinds: ["edits_source"]
    }
  });

  it("rejects when cellsTouched exceeds maxCellsTouched", () => {
    const decision = authorize({
      chain: [budgetLeaf(1)],
      actor: AGENT,
      controller: CONTROLLER,
      requestedOps: ["put_cell"],
      cellsTouched: ["src/a.ts", "src/b.ts"],
      effects: ["edits_source"]
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/maxCellsTouched/);
    }
  });

  it("permits when cellsTouched is within maxCellsTouched", () => {
    expect(
      authorize({
        chain: [budgetLeaf(5)],
        actor: AGENT,
        controller: CONTROLLER,
        requestedOps: ["put_cell"],
        cellsTouched: ["src/a.ts", "src/b.ts"],
        effects: ["edits_source"]
      })
    ).toEqual({ ok: true });
  });
});
