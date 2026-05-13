import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { processMergeGuardEvaluationJob } from "../src/index.js";

async function loadPr(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

async function loadPolicy(name: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), "fixtures", "policies", name), "utf8");
}

describe("Merge Guard worker evaluation jobs", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  it("processes a high-risk PR fixture into a Change Control Record result", async () => {
    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml: await loadPolicy("fintech.yaml")
    });

    expect(result.repositoryFullName).toBe("acme/payments");
    expect(result.pullRequestNumber).toBe(2);
    expect(result.status).toBe("warn");
    expect(result.checkConclusion).toBe("neutral");
    expect(result.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("keeps agent signals as additional scrutiny instead of the only governance gate", async () => {
    const policyYaml = await loadPolicy("enterprise-strict.yaml");
    const human = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-human-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml
    });
    const agent = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-agent-billing",
      pr: await loadPr("billing-agent.json"),
      policyYaml
    });

    expect(human.status).toBe("block");
    expect(agent.status).toBe("block");
    expect(human.checkConclusion).toBe("failure");
    expect(agent.checkConclusion).toBe("failure");
  });

  it("rejects queued jobs that do not contain a pull request payload", async () => {
    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: "delivery-worker-non-pr"
      })
    ).rejects.toThrow("requires a pull request payload");
  });
});
