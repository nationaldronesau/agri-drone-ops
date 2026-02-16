import { test, expect } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Workflow UI Coverage", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("projects workflow supports creating a project", async ({ page }) => {
    await page.goto("/projects");

    await page.getByRole("button", { name: "New Project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create New Project" })).toBeVisible();

    const createButton = dialog.getByRole("button", { name: "Create Project" });
    await expect(createButton).toBeDisabled();

    await dialog.getByLabel("Project Name").fill("South Block Trial");
    await dialog.getByLabel("Farm/Location").fill("Toowoomba");
    await expect(createButton).toBeEnabled();
    await createButton.click();

    await expect(page.getByText("South Block Trial")).toBeVisible({ timeout: 15000 });
  });

  test("upload workflow toggles AI detection controls", async ({ page }) => {
    await page.goto("/upload");

    await expect(page.getByText("Upload Drone Images")).toBeVisible();
    const runDetection = page.locator("button#runDetection");
    await expect(runDetection).toHaveAttribute("data-state", "checked");
    await expect(page.getByText("AI Detection Models")).toBeVisible({ timeout: 15000 });

    await runDetection.click();
    await expect(runDetection).toHaveAttribute("data-state", "unchecked");
    await expect(page.getByText("AI Detection Models")).not.toBeVisible();

    await runDetection.click();
    await expect(runDetection).toHaveAttribute("data-state", "checked");
    await expect(page.getByText("AI Detection Models")).toBeVisible({ timeout: 15000 });
  });

  test("images workflow opens and closes details modal", async ({ page }) => {
    await page.goto("/images");

    await expect(page.getByText(/2 image/i)).toBeVisible();
    await page.getByTitle("View Details").first().click();
    await expect(page.getByText("Image Details and Metadata")).toBeVisible();

    await page.locator("div.fixed.inset-0.bg-black\\/50").click({ position: { x: 8, y: 8 } });
    await expect(page.getByText("Image Details and Metadata")).not.toBeVisible();
  });

  test("camera profiles workflow supports create and delete", async ({ page }) => {
    await page.goto("/camera-profiles");

    await page.getByRole("button", { name: "New Profile" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Profile Name").fill("Thermal Scout");
    await dialog.getByLabel("Description").fill("Thermal drone profile");
    await dialog.getByRole("button", { name: "Create Profile" }).click();
    await expect(page.getByText("Thermal Scout")).toBeVisible({ timeout: 15000 });

    const thermalCard = page.locator("div.border-gray-200").filter({ hasText: "Thermal Scout" }).first();
    page.once("dialog", (alert) => alert.accept());
    await thermalCard.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Thermal Scout")).not.toBeVisible();
  });

  test("mission planner validates selection and can queue a plan", async ({ page }) => {
    await page.goto("/mission-planner");

    await page.getByRole("button", { name: "Generate Spray Plan" }).click();
    await expect(page.getByText("Select a project before generating a spray plan.")).toBeVisible();

    await page.getByRole("combobox", { name: "Project" }).click();
    await page.getByRole("option", { name: /North Farm Survey/ }).click();
    await page.locator("input#name").fill("Autotest Plan");
    await page.getByRole("button", { name: "Generate Spray Plan" }).click();

    await expect(page.getByRole("heading", { name: "Autotest Plan" })).toBeVisible();
  });

  test("orthomosaic and review queue screens show expected actions", async ({ page }) => {
    await page.goto("/orthomosaics");
    await expect(page.getByText("Upload New Orthomosaic")).toBeVisible();
    await expect(page.getByRole("button", { name: "View Map" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to Map" })).toBeVisible();

    await page.goto("/review-queue");
    await page.getByRole("button", { name: "Unassigned" }).click();
    await expect(page.getByText("North Farm Survey")).toBeVisible();
    await expect(page.getByRole("button", { name: "Assign to me" })).toBeVisible();
    await page.getByRole("button", { name: "All Sessions" }).click();
    await expect(page.getByRole("link", { name: "Open Review" })).toBeVisible();
  });
});
