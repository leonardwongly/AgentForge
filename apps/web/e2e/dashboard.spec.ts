import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";

async function seedMergeGuardRecord(
  request: APIRequestContext,
  options: { mode?: "observe" | "warn" | "enforce" | "optimize"; repositoryFullName?: string } = {}
): Promise<ChangeControlRecord> {
  const [rawPr, contentYaml] = await Promise.all([
    readFile(path.resolve(process.cwd(), "fixtures", "repos", "billing-path.json"), "utf8"),
    readFile(path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"), "utf8")
  ]);
  const pr = JSON.parse(rawPr) as PullRequestInput;
  if (options.repositoryFullName) {
    pr.repositoryFullName = options.repositoryFullName;
    pr.pullRequestNumber = 9002;
  }
  const policyYaml = options.mode
    ? contentYaml.replace(/mode: warn/u, `mode: ${options.mode}`)
    : contentYaml;
  const preview = await request.post(`${apiBaseUrl}/api/policies/preview`, {
    data: { pr, contentYaml: policyYaml, persist: true },
    headers: {
      "x-agentforge-actor": "playwright",
      "x-agentforge-role": "platform_admin"
    }
  });
  expect(preview.ok()).toBeTruthy();
  const payload = (await preview.json()) as { record: ChangeControlRecord };
  const policyUpdate = await request.put(
    `${apiBaseUrl}/api/repositories/${payload.record.repositoryId}/policy`,
    {
      data: { contentYaml: policyYaml },
      headers: {
        "x-agentforge-actor": "playwright",
        "x-agentforge-role": "platform_admin"
      }
    }
  );
  expect(policyUpdate.ok()).toBeTruthy();
  return payload.record;
}

test("dashboard shows action-required pull requests first", async ({ page, request }) => {
  await seedMergeGuardRecord(request);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Merge Guard Dashboard" })).toBeVisible();
  await expect(
    page.getByLabel("Primary navigation").getByRole("link", { name: "Blocked PRs" })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Priority queue" })).toBeVisible();
  await expect(page.getByText("required evidence missing").first()).toBeVisible();
  await expect(page.getByText("required reviewer pending").first()).toBeVisible();
});

test("governance drill-down routes render careful change-control language", async ({
  page,
  request
}) => {
  const record = await seedMergeGuardRecord(request);
  const routes = [
    ["/onboarding", "Onboarding", "Connect GitHub App"],
    ["/dashboard/blocked-prs", "Blocked PRs", "Action-required pull requests"],
    ["/dashboard/policy-violations", "Policy Violations", "policy findings"],
    ["/dashboard/overrides", "Overrides", "Authorized override activity"],
    ["/dashboard/evidence-completion", "Evidence Completion", "Required evidence missing"],
    ["/dashboard/policy-insights", "Policy Insights", "Advisory recommendations"],
    ["/records", "Change Control Records", "Record index"],
    [`/records/${record.id}`, "Change Control Record", "Verified findings"],
    [`/repositories/${record.repositoryId}/policy`, "Policy Editor", "Active repository policy"],
    [`/repositories/${record.repositoryId}/policy-preview`, "Policy Preview", "Recent PR preview"],
    ["/settings", "Settings", "Data handling"]
  ] as const;

  for (const [route, heading, expectedText] of routes) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText(expectedText).first()).toBeVisible();
    await expect(page.getByText("unsafe PR")).toHaveCount(0);
    await expect(page.getByText("bad AI code")).toHaveCount(0);
    await expect(page.getByText("AI firewall")).toHaveCount(0);
    await expect(page.getByText("guaranteed safe")).toHaveCount(0);
  }
});

test("settings form persists repository mode, retention, and owner mappings", async ({
  page,
  request
}) => {
  const [rawPr] = await Promise.all([
    readFile(path.resolve(process.cwd(), "fixtures", "repos", "billing-path.json"), "utf8"),
    seedMergeGuardRecord(request)
  ]);
  const pr = JSON.parse(rawPr) as PullRequestInput;

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("Mode").selectOption("optimize");
  await page.getByLabel("Full diff retention").selectOption("7d");
  await page.getByLabel("Owner key 1").fill("runtime_owner");
  await page.getByLabel("Reviewer 1").fill("runtime-team");
  await page.getByLabel("Reviewer type 1").selectOption("team");
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(page.getByText("Repository settings saved")).toBeVisible();
  await expect(page.getByLabel("Mode")).toHaveValue("optimize");
  await expect(page.getByLabel("Full diff retention")).toHaveValue("7d");
  await expect(page.getByLabel("Owner key 1")).toHaveValue("runtime_owner");
  await expect(page.getByLabel("Reviewer 1")).toHaveValue("runtime-team");

  const activePolicyPreview = await request.post(`${apiBaseUrl}/api/policies/preview`, {
    data: { pr }
  });
  expect(activePolicyPreview.ok()).toBeTruthy();
  const previewPayload = (await activePolicyPreview.json()) as {
    result: { mode: string; status: string };
  };
  expect(previewPayload.result).toMatchObject({ mode: "optimize", status: "block" });

  const settingsResponse = await request.get(`${apiBaseUrl}/api/settings`);
  expect(settingsResponse.ok()).toBeTruthy();
  const settingsPayload = (await settingsResponse.json()) as {
    ownerMappings: Array<{ ownerKey?: string; reviewer: string; sources: string[] }>;
  };
  expect(settingsPayload.ownerMappings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ownerKey: "runtime_owner",
        reviewer: "runtime-team"
      })
    ])
  );
});

test("first-user actions create exports and route to preview/configuration", async ({
  page,
  request
}) => {
  await seedMergeGuardRecord(request);
  await seedMergeGuardRecord(request, {
    mode: "observe",
    repositoryFullName: "acme/observe-payments"
  });

  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Action queues" }).click();
  await expect(page).toHaveURL(/\/dashboard\/blocked-prs$/u);

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Export records" }).click();
  await expect(page.getByRole("heading", { name: "Export created" })).toBeVisible();
  await expect(page).toHaveURL(/updated=records-export.*exportId=/u);
  await expect(page.getByText(/contains \d+ Change Control Records/u)).toBeVisible();
  await expect(page.getByText("observe pass; requirements open").first()).toBeVisible();
  await expect(page.getByText("would block in enforce").first()).toBeVisible();

  await page.goto("/records");
  await page.getByRole("button", { name: "Export records" }).click();
  await expect(page.getByRole("heading", { name: "Export created" })).toBeVisible();
  await expect(page).toHaveURL(/updated=records-export.*exportId=/u);
  await expect(page.getByText(/contains \d+ Change Control Records/u)).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Create export" }).click();
  await expect(page.getByRole("heading", { name: "Audit export created" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit exports" })).toBeVisible();

  await page.goto("/onboarding");
  await page.getByRole("link", { name: "Run preview" }).click();
  await expect(page).toHaveURL(/\/repositories\/[^/]+\/policy-preview$/u);
  await expect(page.getByRole("heading", { name: "Policy Preview" })).toBeVisible();

  await page.goto("/repositories/repo_without_policy/policy");
  await expect(page.getByRole("heading", { name: "No active policy version yet" })).toBeVisible();
  await expect(page.getByLabel("Repository policy YAML")).toContainText(
    "policy_pack_id: startup-default"
  );

  await page.goto("/dashboard/blocked-prs");
  await page.getByRole("link", { name: "Tune filters" }).click();
  await expect(page).toHaveURL(/\/settings$/u);
});

test("evidence workflow resolves requirements through record actions", async ({
  page,
  request
}) => {
  const record = await seedMergeGuardRecord(request, {
    mode: "enforce",
    repositoryFullName: "acme/evidence-workflow"
  });

  await page.goto("/dashboard/evidence-completion");
  await page.getByRole("link", { name: "Submit evidence" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/records/${record.id}$`, "u"));

  for (let index = 0; index < record.requiredEvidence.length; index += 1) {
    await page
      .getByLabel("Evidence content")
      .first()
      .fill("Security note: token was revoked and the rotation evidence is linked in SEC-123.");
    await page.getByRole("button", { name: "Submit evidence" }).first().click();
    await expect(page.getByRole("heading", { name: "Evidence submitted" })).toBeVisible();
  }
  await expect(page.getByText("provided").first()).toBeVisible();

  for (let index = 0; index < record.requiredEvidence.length; index += 1) {
    await page.getByRole("button", { name: "Approve evidence" }).first().click();
    await expect(page.getByRole("heading", { name: "Evidence approved" })).toBeVisible();
  }
  await expect(page.getByText("approved").first()).toBeVisible();

  await page.getByRole("button", { name: "Approve reviewer" }).first().click();
  await expect(page.getByRole("heading", { name: "Reviewer approved" })).toBeVisible();
  await expect(page.getByText("pass").first()).toBeVisible();

  const updated = await request.get(
    `${apiBaseUrl}/api/pull-requests/${record.id}/change-control-record`
  );
  expect(updated.ok()).toBeTruthy();
  const updatedPayload = (await updated.json()) as { record: ChangeControlRecord };
  expect(updatedPayload.record.checkStatus).toBe("pass");
  expect(
    updatedPayload.record.requiredEvidence.every((evidence) => evidence.status === "approved")
  ).toBe(true);

  await page.goto("/dashboard/evidence-completion");
  await expect(page.getByText("acme/evidence-workflow").first()).toBeVisible();
  await expect(page.getByText("complete").first()).toBeVisible();
});
