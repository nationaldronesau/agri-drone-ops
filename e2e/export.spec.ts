import { test, expect } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Export Workflow", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
    await page.goto("/export");
  });

  test("shows format cards, source toggles, and usage instructions", async ({ page }) => {
    await expect(page.getByText("Export Detection Data")).toBeVisible();
    await expect(page.getByRole("heading", { name: "CSV Format", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "KML Format", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shapefile", exact: true })).toBeVisible();

    await expect(page.getByRole("checkbox", { name: "Include AI Detections" })).toHaveAttribute(
      "data-state",
      "checked"
    );
    await expect(
      page.getByRole("checkbox", { name: "Include Manual Annotations" })
    ).toHaveAttribute("data-state", "checked");
    await expect(
      page.getByRole("checkbox", { name: /Include SAM3 Pending Annotations/ })
    ).toHaveAttribute("data-state", "unchecked");
    await expect(page.getByRole("checkbox", { name: /Include metadata/ })).toHaveAttribute(
      "data-state",
      "checked"
    );

    await expect(page.getByText("How to Use Exported Data")).toBeVisible();
    await expect(page.getByText("Open in Excel, Google Sheets")).toBeVisible();
    await expect(page.getByText("View in Google Earth")).toBeVisible();
    await expect(page.getByText("Direct import into DJI Terra")).toBeVisible();
  });

  test("allows changing export format and filters", async ({ page }) => {
    await page.getByText("Shapefile").first().click();
    await expect(page.getByText("• Format: SHAPEFILE")).toBeVisible();

    await page.getByRole("checkbox", { name: "Wattle" }).click();
    await expect(page.getByRole("checkbox", { name: "Wattle" })).toHaveAttribute(
      "data-state",
      "unchecked"
    );

    await page.getByRole("checkbox", { name: "Include AI Detections" }).click();
    await expect(page.getByRole("checkbox", { name: "Include AI Detections" })).toHaveAttribute(
      "data-state",
      "unchecked"
    );

    await expect(page.getByRole("checkbox", { name: /Include SAM3 Pending Annotations/ })).toBeDisabled();
  });

  test("submits export request with selected options", async ({ page }) => {
    let requestedUrl: string | null = null;

    await page.route(/\/api\/export\/stream(?:\?.*)?$/, async (route) => {
      requestedUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "application/zip",
        body: "mock-zip-content",
      });
    });

    await page.getByText("Shapefile").first().click();
    await page.getByRole("combobox", { name: "Filter by Project" }).click();
    await page.getByRole("option", { name: /North Farm Survey/ }).click();
    await page.getByRole("checkbox", { name: "Wattle" }).click();
    await page.getByRole("button", { name: /Export \d+ Detections/ }).click();

    await expect.poll(() => requestedUrl).not.toBeNull();
    expect(requestedUrl ?? "").toContain("format=shapefile");
    expect(requestedUrl ?? "").toContain("projectId=proj-1");
    expect(requestedUrl ?? "").toContain("includeAI=true");
    expect(requestedUrl ?? "").toContain("includeManual=true");
    expect(requestedUrl ?? "").not.toContain("includePending=true");
    expect(requestedUrl ?? "").toContain("classes=Lantana");
  });
});
