import { test, expect } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Smoke Coverage", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("landing and auth pages render", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/AgriDrone/i);
    await expect(page.getByRole("link", { name: "Get Started" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start Free Trial" })).toBeVisible();

    await page.goto("/auth/signin");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    await page.goto("/auth/signup");
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Confirm Password")).toBeVisible();
  });

  test("main application routes render", async ({ page }) => {
    const routes: Array<{ path: string; expectedText: string }> = [
      { path: "/dashboard", expectedText: "Welcome back" },
      { path: "/projects", expectedText: "Projects" },
      { path: "/upload", expectedText: "Upload Drone Images" },
      { path: "/images", expectedText: "Uploaded Images" },
      { path: "/map", expectedText: "Interactive Map" },
      { path: "/training-hub", expectedText: "Training Hub" },
      { path: "/training", expectedText: "YOLO Training Dashboard" },
      { path: "/review-queue", expectedText: "Review Queue" },
      { path: "/mission-planner", expectedText: "Mission Planner" },
      { path: "/export", expectedText: "Export Detection Data" },
      { path: "/orthomosaics", expectedText: "Orthomosaics" },
      { path: "/camera-profiles", expectedText: "Camera Profiles" },
    ];

    for (const route of routes) {
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(route.expectedText).first()).toBeVisible();
    }
  });

  test("training workflow setup routes render", async ({ page }) => {
    await page.goto("/training-hub/new-species");
    await expect(page.getByRole("heading", { name: "Label New Species" })).toBeVisible();
    await expect(page.getByText("Step 1: Select source and target")).toBeVisible();

    await page.goto("/training-hub/improve");
    await expect(page.getByRole("heading", { name: "Improve Existing Model" })).toBeVisible();
    await expect(page.getByText("Step 1: Select project and model")).toBeVisible();
  });

  test("review page handles missing session id", async ({ page }) => {
    await page.goto("/review");
    await expect(page.getByText("Missing sessionId in URL")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Training Hub" })).toBeVisible();
  });
});
