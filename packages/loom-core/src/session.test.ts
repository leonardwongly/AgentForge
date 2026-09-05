import { describe, expect, it } from "vitest";

import type { Did } from "./types.js";
import { SessionStore } from "./session.js";

const AGENT = "did:loom:agent" as Did;

describe("delegated agent sessions", () => {
  it("creates an active session scoped to a write prefix", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/billing/"] });
    expect(session.status).toBe("active");
    expect(store.get(session.id)?.agentDid).toBe(AGENT);
  });

  it("permits writes only within the write scope and budget", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/billing/"], maxWrites: 2 });

    expect(store.canWrite(session, "src/billing/checkout.ts")).toBe(true);
    expect(store.canWrite(session, "src/other/x.ts")).toBe(false);

    expect(store.recordWrite(session, "src/billing/a.ts")).toBe(true);
    expect(store.recordWrite(session, "src/billing/b.ts")).toBe(true);
    // Budget exhausted.
    expect(store.recordWrite(session, "src/billing/c.ts")).toBe(false);
    expect(session.writes).toBe(2);
  });

  it("rejects writes after the session is completed or cancelled", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/"] });
    store.complete(session.id);
    expect(store.canWrite(session, "src/a.ts")).toBe(false);
    expect(store.recordWrite(session, "src/a.ts")).toBe(false);
  });

  it("tracks status transitions", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/"] });
    expect(store.cancel(session.id)?.status).toBe("cancelled");
    // Cannot complete a cancelled session.
    expect(store.complete(session.id)?.status).toBe("cancelled");
  });

  it("isolates distinct sessions", () => {
    const store = new SessionStore();
    const a = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/a/"] });
    const b = store.create({ agentDid: AGENT, grantId: "g2", writeScope: ["src/b/"] });
    expect(store.canWrite(a, "src/a/x.ts")).toBe(true);
    expect(store.canWrite(b, "src/a/x.ts")).toBe(false);
  });

  it("does not accept a caller-forged session object", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src/"] });
    const forged = { ...session, writeScope: ["secrets/"] };
    expect(store.canWrite(forged, "secrets/key")).toBe(false);
    expect(store.recordWrite(forged, "secrets/key")).toBe(false);
    expect(session.writes).toBe(0);
  });

  it("matches scope boundaries instead of textual prefixes", () => {
    const store = new SessionStore();
    const session = store.create({ agentDid: AGENT, grantId: "g1", writeScope: ["src"] });
    expect(store.canWrite(session, "src/app.ts")).toBe(true);
    expect(store.canWrite(session, "src")).toBe(true);
    expect(store.canWrite(session, "src-private/app.ts")).toBe(false);
    expect(store.canWrite(session, "src/../secrets/key")).toBe(false);
  });
});
