import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import {
  getPolicyPackByRef,
  listPolicyPacks,
  policyPackRef,
  previewPolicyPackImpact
} from "./registry.js";
import { getPolicyPack } from "./packs.js";

const pr: PullRequestInput = {
  repositoryFullName: "acme/app",
  pullRequestNumber: 1,
  title: "Docs",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "docs",
  headSha: "sha",
  changedFiles: []
};

describe("policy pack registry", () => {
  it("lists version-qualified, shareable pack refs", () => {
    const summaries = listPolicyPacks();
    expect(summaries.length).toBeGreaterThan(0);
    const startup = summaries.find((pack) => pack.id === "startup-default");
    expect(startup?.ref).toBe("startup-default@1.0.0");
  });

  it("resolves packs by id and by id@version", () => {
    expect(getPolicyPackByRef("startup-default")?.id).toBe("startup-default");
    expect(getPolicyPackByRef("startup-default@1.0.0")?.id).toBe("startup-default");
    expect(getPolicyPackByRef("startup-default@9.9.9")).toBeUndefined();
  });

  it("produces a shareable ref for a pack", () => {
    const pack = getPolicyPack("startup-default");
    expect(pack && policyPackRef(pack)).toBe("startup-default@1.0.0");
  });

  it("previews pack impact as a non-blocking deterministic evaluation", () => {
    const pack = getPolicyPack("startup-default");
    expect(pack).toBeDefined();
    const result = previewPolicyPackImpact({ pack: pack!, pr, facts: [] });
    expect(result.mode).toBe("warn");
    expect(result.status).toBe("pass");
  });
});
