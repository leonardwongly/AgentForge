import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";

async function seedMergeGuardRecord(request: APIRequestContext): Promise<ChangeControlRecord> {
  const [rawPr, contentYaml] = await Promise.all([
    readFile(path.resolve(process.cwd(), "fixtures", "repos", "billing-path.json"), "utf8"),
    readFile(path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"), "utf8")
  ]);
  const pr = JSON.parse(rawPr) as PullRequestInput;
  const preview = await request.post(`${apiBaseUrl}/api/policies/preview`, {
    data: { pr, contentYaml }
  });
  expect(preview.ok()).toBeTruthy();
  const payload = (await preview.json()) as { record: ChangeControlRecord };
  const policyUpdate = await request.put(
    `${apiBaseUrl}/api/repositories/${payload.record.repositoryId}/policy`,
    {
      data: { contentYaml },
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
