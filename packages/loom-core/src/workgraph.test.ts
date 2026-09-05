import { describe, expect, it } from "vitest";

import { WorkGraph } from "./workgraph.js";

describe("agent work graph", () => {
  it("adds nodes and returns a topological order", () => {
    const graph = new WorkGraph();
    const a = graph.addNode({ agentDid: "did:loom:a", sessionId: "s1", title: "a" });
    const b = graph.addNode({ agentDid: "did:loom:b", sessionId: "s2", title: "b" });
    graph.addEdge(a.id, b.id); // b depends on a
    const order = graph.topologicalOrder();
    expect(order?.map((n) => n.title)).toEqual(["a", "b"]);
  });

  it("orders a chain of dependencies", () => {
    const graph = new WorkGraph();
    const a = graph.addNode({ agentDid: "d", sessionId: "s1", title: "a" });
    const b = graph.addNode({ agentDid: "d", sessionId: "s2", title: "b" });
    const c = graph.addNode({ agentDid: "d", sessionId: "s3", title: "c" });
    graph.addEdge(a.id, b.id);
    graph.addEdge(b.id, c.id);
    expect(graph.topologicalOrder()?.map((n) => n.title)).toEqual(["a", "b", "c"]);
  });

  it("detects cycles", () => {
    const graph = new WorkGraph();
    const a = graph.addNode({ agentDid: "d", sessionId: "s1" });
    const b = graph.addNode({ agentDid: "d", sessionId: "s2" });
    graph.addEdge(a.id, b.id);
    graph.addEdge(b.id, a.id);
    expect(graph.hasCycle()).toBe(true);
    expect(graph.topologicalOrder()).toBeUndefined();
  });

  it("rejects self-edges and unknown nodes", () => {
    const graph = new WorkGraph();
    const a = graph.addNode({ agentDid: "d", sessionId: "s1" });
    expect(() => graph.addEdge(a.id, a.id)).toThrow(/self-edge/);
    expect(() => graph.addEdge(a.id, "missing")).toThrow(/unknown node/);
  });

  it("traces a node back to its agent and session", () => {
    const graph = new WorkGraph();
    const node = graph.addNode({
      agentDid: "did:loom:agent",
      sessionId: "sess-1",
      transformCid: "cid-1"
    });
    expect(graph.get(node.id)).toMatchObject({
      agentDid: "did:loom:agent",
      sessionId: "sess-1",
      transformCid: "cid-1"
    });
  });
});
