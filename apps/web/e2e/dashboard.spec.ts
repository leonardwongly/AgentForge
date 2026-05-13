import { expect, test } from "@playwright/test";

test("dashboard shows action-required pull requests first", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Merge Guard Dashboard" })).toBeVisible();
  await expect(
    page.getByLabel("Primary navigation").getByRole("link", { name: "Blocked PRs" })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Priority queue" })).toBeVisible();
  await expect(page.getByText("required evidence missing").first()).toBeVisible();
  await expect(page.getByText("required reviewer pending").first()).toBeVisible();
});

test("governance drill-down routes render careful change-control language", async ({ page }) => {
  await page.goto("/dashboard/blocked-prs");
  const recordHref =
    (await page.getByRole("link", { name: "Record", exact: true }).first().getAttribute("href")) ??
    "/records/ccr_demo";
  const routes = [
    ["/onboarding", "Onboarding", "Connect GitHub App"],
    ["/dashboard/blocked-prs", "Blocked PRs", "Action-required pull requests"],
    ["/dashboard/policy-violations", "Policy Violations", "policy findings"],
    ["/dashboard/overrides", "Overrides", "Authorized override activity"],
    ["/dashboard/evidence-completion", "Evidence Completion", "Required evidence missing"],
    ["/records", "Change Control Records", "Record index"],
    [recordHref, "Change Control Record", "Verified findings"],
    ["/repositories/repo_local/policy", "Policy Editor", "Fintech policy pack fork"],
    ["/repositories/repo_local/policy-preview", "Policy Preview", "Recent PR preview"],
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
