import { expect, test } from "@playwright/test";

test.describe("adversarial confused-user navigation", () => {
  test("explains an unknown opaque record id without claiming the dataset is empty", async ({
    page
  }) => {
    await page.goto("/records/%2F%2Fmissing%3Fquery%23fragment");

    await expect(page.getByRole("heading", { name: "Record not found", exact: true })).toHaveCount(
      1
    );
    await expect(
      page.getByRole("heading", { name: "No Change Control Records yet", exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open onboarding", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("bounds hostile record query values and keeps injected markup inert", async ({ page }) => {
    const injectedText = "<img src=x onerror=alert(1)>";
    await page.goto(
      `/records?limit=0&offset=-999999999999999999999999&status=unknown&error=${encodeURIComponent(injectedText)}`
    );

    await expect(
      page.getByRole("heading", { name: "Change Control Records", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Export was not created", exact: true })
    ).toBeVisible();
    await expect(page.getByText(injectedText, { exact: true })).toBeVisible();
    await expect(page.locator("[onerror]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/(?:NaN|Infinity)/u);
    await expect(page.getByLabel("Record pagination")).toContainText(/Showing \d+-\d+ of \d+/u);
  });

  test("keeps the policy navigation label aligned with its destination", async ({ page }) => {
    await page.goto("/dashboard");

    const policyLink = page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("link", { name: "Policy Violations", exact: true });
    await expect(policyLink).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "Primary navigation" })
        .getByRole("link", { name: "Policy Findings", exact: true })
    ).toHaveCount(0);

    await policyLink.click();
    await expect(page).toHaveURL(/\/dashboard\/policy-violations$/u);
    await expect(
      page.getByRole("heading", { name: "Policy Violations", exact: true })
    ).toBeVisible();
  });

  test("keeps primary navigation keyboard reachable at a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/dashboard");

    const navigation = page.getByRole("complementary", { name: "Primary navigation" });
    const links = navigation.getByRole("link");
    const geometry = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      })
    );
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(geometry.length).toBeGreaterThan(0);
    expect(
      geometry.every(({ left, right, width }) => left >= 0 && right <= viewportWidth && width > 0)
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewportWidth
    );

    await navigation.getByRole("link", { name: "Policy Violations", exact: true }).focus();
    await expect(
      navigation.getByRole("link", { name: "Policy Violations", exact: true })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dashboard\/policy-violations$/u);
  });
});
