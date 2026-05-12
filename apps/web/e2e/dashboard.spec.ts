import { expect, test } from "@playwright/test";

test("dashboard shows action-required pull requests first", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Merge Guard Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Blocked PRs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Action-required pull requests" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Records/ })).toBeVisible();
});
