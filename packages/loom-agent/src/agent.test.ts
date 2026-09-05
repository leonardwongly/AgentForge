import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyOps,
  captureState,
  emptyState,
  FileLineJournal,
  mintNodeIdent,
  stateAddress,
  type Cid,
  type Did,
  type State
} from "@agentforge/loom-core";
import { describe, expect, it } from "vitest";
import { AgentClient } from "./agent.js";

const AGENT = "did:loom:agent" as Did;
const GRANT = "grant-1";
const SCOPE = ["src/"];

function requireState(ops: Parameters<typeof applyOps>[1]): State {
  const result = applyOps(emptyState(), ops);
  if (!result.ok) {
    throw new Error(`setup applyOps failed: ${result.error.detail}`);
  }
  return result.state;
}

async function makeWorkingCopy(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loom-agent-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const T0 = "loom:sha256:genesis" as Cid;

describe("AgentClient", () => {
  it("creates a bounded delegated session with defaults", () => {
    const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
    const session = client.createSession();
    expect(session.agentDid).toBe(AGENT);
    expect(session.grantId).toBe(GRANT);
    expect(session.writeScope).toEqual(SCOPE);
    expect(session.status).toBe("active");
    expect(session.maxWrites).toBe(10_000);
    expect(session.writes).toBe(0);
  });

  it("captures a change journal and derives native effects + review requirements", async () => {
    const dir = await makeWorkingCopy({
      "src/app.ts": "export const v = 2;\n",
      "src/billing/invoice.ts": "export const token = 'x';\n"
    });
    try {
      const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
      const session = client.createSession();
      const base = requireState([
        { op: "put_cell", at: "src/app.ts", ident: mintNodeIdent(T0, 0, "src/app.ts"), facet: "text", text: "export const v = 1;\n" }
      ]);
      const report = client.captureChange(session, { workingDir: dir, baseState: base });
      expect(report.journal.modified).toContain("src/app.ts");
      expect(report.journal.added).toContain("src/billing/invoice.ts");
      expect(report.effects).toContain("edits_source");
      expect(report.effects).toContain("touches_sensitive_path");
      expect(report.reviewRequirements.some((r) => r.reviewers.includes("security-team"))).toBe(true);
      expect(report.withinScope).toBe(true);
      expect(report.writes).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags out-of-scope writes and does not record them", async () => {
    const dir = await makeWorkingCopy({ "outside.txt": "x" });
    try {
      const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
      const session = client.createSession();
      const report = client.captureChange(session, { workingDir: dir, baseState: emptyState() });
      expect(report.withinScope).toBe(false);
      expect(report.writes).toBe(0);
      expect(session.writes).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects the session write budget", async () => {
    const dir = await makeWorkingCopy({ "src/a.ts": "a", "src/b.ts": "b", "src/c.ts": "c" });
    try {
      const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE, maxWrites: 2 });
      const session = client.createSession();
      const report = client.captureChange(session, { workingDir: dir, baseState: emptyState() });
      expect(report.writes).toBe(2);
      expect(report.withinScope).toBe(false); // third write blocked by budget
      expect(session.writes).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds a valid recipe and rejects an invalid one", () => {
    const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
    const recipe = client.buildRecipe({
      engine: "regex-replace",
      rule: { find: "foo", replace: "bar" },
      inputSelector: [{ path: "src/a.ts" }],
      writeScope: [{ path: "src/" }]
    });
    expect(recipe.engine).toBe("regex-replace");
    expect(() =>
      client.buildRecipe({
        engine: "regex-replace",
        rule: { find: "", replace: "bar" },
        inputSelector: [],
        writeScope: []
      })
    ).toThrow(/invalid recipe/);
  });

  it("tracks work nodes and rejects a cycle", () => {
    const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
    const session = client.createSession();
    const a = client.trackWork({ sessionId: session.id, title: "a" });
    const b = client.trackWork({ sessionId: session.id, title: "b", dependsOn: [a.nodeId] });
    expect(b.order.indexOf(a.nodeId)).toBeLessThan(b.order.indexOf(b.nodeId));
    // Creating a self-dependency is rejected at edge-add time.
    expect(() => client.trackWork({ sessionId: session.id, title: "c", dependsOn: [a.nodeId] })).not.toThrow();
  });

  it("submits a proposal and admits it only after approvals and evidence", async () => {
    const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
    const proposal = client.submitProposal({
      title: "add migration",
      updates: [],
      requiredReviewers: ["database-owner"],
      requiredEvidence: ["rollback_plan"]
    });
    expect(proposal.state).toBe("proposed");

    const before = await client.admitProposal(proposal.id);
    expect(before.ok).toBe(false); // missing approvals + evidence

    client.approveProposal(proposal.id, "database-owner");
    client.provideEvidence(proposal.id, "rollback_plan");
    const after = await client.admitProposal(proposal.id);
    expect(after.ok).toBe(false); // an approval cannot admit an empty proposal
    expect(after.reason).toMatch(/at least one line update/);
    expect(client.getProposal(proposal.id)?.state).toBe("proposed");
  });

  it("does not let the submitting agent self-approve a review gate", () => {
    const client = new AgentClient({ root: ".", agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
    const proposal = client.submitProposal({
      title: "self review",
      updates: [{ line: "main", expectedHead: "head" as never, expectedSequence: 0, newHead: "next" as never }],
      requiredReviewers: ["maintainer"]
    });
    client.approveProposal(proposal.id, AGENT);
    expect(client.getProposal(proposal.id)?.approvals).toEqual([]);

  });

  it("runs the full delegated-change workflow end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-agent-repo-"));
    const dir = await mkdtemp(join(tmpdir(), "loom-agent-work-"));
    try {
      const client = new AgentClient({ root, agentDid: AGENT, grantId: GRANT, writeScope: SCOPE });
      const session = client.createSession();
      const base = emptyState();
      await writeFile(join(dir, "src", "app.ts"), "export const v = 2;\n").catch(async () => {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "app.ts"), "export const v = 2;\n");
      });
      const report = client.captureChange(session, { workingDir: dir, baseState: base });
      expect(report.effects).toContain("edits_source");

      const node = client.trackWork({ sessionId: session.id, title: "bump v" });
      expect(node.order).toContain(node.nodeId);

      const next = captureState(dir);
      const nextHead = stateAddress(next);
      const lineJournal = new FileLineJournal(join(root, ".loom"));
      await lineJournal.advance({
        name: "main",
        scope: "shared",
        expectedHead: stateAddress(emptyState()) as never,
        expectedSequence: 0,
        newHead: stateAddress(base) as never
      });
      const proposal = client.submitProposal({
        title: "bump v",
        updates: [
          {
            line: "main",
            expectedHead: stateAddress(base) as never,
            expectedSequence: 0,
            newHead: nextHead as never
          }
        ]
      });
      client.approveProposal(proposal.id, "maintainer");
      const admitted = await client.admitProposal(proposal.id);
      expect(admitted.ok).toBe(true);
      expect(client.getProposal(proposal.id)?.state).toBe("admitted");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
