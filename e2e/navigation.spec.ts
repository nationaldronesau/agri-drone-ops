import { test, expect } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Navigation Flows", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("dashboard quick actions navigate to core tools", async ({ page }) => {
    await page.goto("/dashboard");

    await page.locator("main").getByRole("link", { name: "Upload" }).first().click();
    await expect(page).toHaveURL(/\/upload$/);
    await expect(page.getByRole("heading", { name: "Upload Drone Images" })).toBeVisible();

    await page.goto("/dashboard");
    await page.locator("main").getByRole("link", { name: "Export" }).first().click();
    await expect(page).toHaveURL(/\/export$/);
    await expect(page.getByRole("heading", { name: "Export Detection Data" })).toBeVisible();
  });

  test("sidebar links and collapse toggle work", async ({ page }) => {
    await page.goto("/dashboard");

    const sidebar = page.locator("aside");

    await sidebar.getByRole("link", { name: "Projects" }).click();
    await expect(page).toHaveURL(/\/projects$/);

    await sidebar.getByRole("link", { name: "Images" }).click();
    await expect(page).toHaveURL(/\/images$/);

    await sidebar.getByRole("link", { name: "Mission Planner" }).click();
    await expect(page).toHaveURL(/\/mission-planner$/);

    await expect(sidebar.getByText("Overview")).toBeVisible();
  });

  test("training hub cards route to guided workflows", async ({ page }) => {
    await page.goto("/training-hub");

    await page.locator('a[href="/training-hub/new-species"]').first().click();
    await expect(page).toHaveURL(/\/training-hub\/new-species$/);
    await expect(page.getByText("Step 1: Select source and target")).toBeVisible();

    await page.goto("/training-hub");
    await page.locator('a[href="/training-hub/improve"]').first().click();
    await expect(page).toHaveURL(/\/training-hub\/improve$/);
    await expect(page.getByText("Step 1: Select project and model")).toBeVisible();
  });
});
