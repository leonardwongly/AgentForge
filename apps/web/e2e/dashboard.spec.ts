import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const readActorHeaders = {
  "x-agentforge-actor": "playwright",
  "x-agentforge-role": "platform_admin",
  "x-agentforge-organization": "org_local"
};

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

test("fresh onboarding can create a local sample preview", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "No repositories are connected yet" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Run sample preview" }).first().click();

  await expect(page.getByRole("heading", { name: "Sample preview created" })).toBeVisible();
  await expect(page.locator("select#repositoryId")).toContainText("acme/first-run-payments");
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeVisible();
});

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

test("policy preview scopes records and reports exclusive counters", async ({ page, request }) => {
  const scopedRecord = await seedMergeGuardRecord(request, {
    mode: "warn",
    repositoryFullName: "acme/scoped-preview"
  });
  await seedMergeGuardRecord(request, {
    mode: "warn",
    repositoryFullName: "acme/other-preview"
  });

  await page.goto(`/repositories/${scopedRecord.repositoryId}/policy-preview`);

  await expect(page.getByRole("heading", { name: "Policy Preview" })).toBeVisible();
  await expect(page.getByText("acme/scoped-preview").first()).toBeVisible();
  await expect(page.getByText("acme/other-preview")).toHaveCount(0);

  const metrics = await page.locator(".metric-card").evaluateAll((cards) =>
    cards.map((card) => ({
      label: card.querySelector("span")?.textContent?.trim(),
      value: card.querySelector("strong")?.textContent?.trim()
    }))
  );
  expect(metrics).toEqual(
    expect.arrayContaining([
      { label: "Would block", value: "1" },
      { label: "Would warn", value: "0" },
      { label: "Would pass", value: "0" }
    ])
  );
});

test("policy findings render repeated findings without duplicate key errors", async ({
  page,
  request
}) => {
  await seedMergeGuardRecord(request, {
    mode: "warn",
    repositoryFullName: "acme/repeated-finding-a"
  });
  await seedMergeGuardRecord(request, {
    mode: "warn",
    repositoryFullName: "acme/repeated-finding-b"
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/dashboard/policy-violations");
  await expect(page.getByRole("heading", { name: "Policy Violations" })).toBeVisible();
  await expect(page.getByText("acme/repeated-finding-a").first()).toBeVisible();
  await expect(page.getByText("acme/repeated-finding-b").first()).toBeVisible();
  expect(consoleErrors.some((message) => message.includes("same key"))).toBe(false);
});

test("overrides page distinguishes no overrides from no records", async ({ page, request }) => {
  await seedMergeGuardRecord(request, {
    mode: "warn",
    repositoryFullName: "acme/no-overrides"
  });

  await page.goto("/dashboard/overrides");

  await expect(page.getByRole("heading", { name: "Overrides", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No authorized overrides yet" })).toBeVisible();
  await expect(page.getByText("No Change Control Records yet")).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
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
  const [rawPr, contentYaml] = await Promise.all([
    readFile(path.resolve(process.cwd(), "fixtures", "repos", "billing-path.json"), "utf8"),
    readFile(path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"), "utf8"),
    seedMergeGuardRecord(request)
  ]);
  const pr = JSON.parse(rawPr) as PullRequestInput;

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const selectedRepositoryFullName = await page
    .locator("#repositoryId option:checked")
    .textContent();
  expect(selectedRepositoryFullName).toBeTruthy();
  pr.repositoryFullName = selectedRepositoryFullName!.trim();

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
    data: { pr, contentYaml }
  });
  expect(activePolicyPreview.ok()).toBeTruthy();
  const previewPayload = (await activePolicyPreview.json()) as {
    result: { mode: string; status: string };
  };
  expect(previewPayload.result).toMatchObject({ mode: "optimize", status: "block" });

  const settingsResponse = await request.get(`${apiBaseUrl}/api/settings`, {
    headers: readActorHeaders
  });
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
    `${apiBaseUrl}/api/pull-requests/${record.id}/change-control-record`,
    { headers: readActorHeaders }
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
