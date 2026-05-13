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
