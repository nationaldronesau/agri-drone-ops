import { expect, test } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Labeling And YOLO Training", () => {
  test("review labeling flow can accept items and start YOLO training", async ({ page }) => {
    await setupMockApi(page);

    await page.goto("/review?sessionId=review-1");
    await expect(page.getByText("Review Session")).toBeVisible();
    await expect(page.getByText("1 reviewed · 1 accepted · 0 rejected")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Accept filtered \(1\)/ }).click();

    await expect(page.getByText("2 reviewed · 2 accepted · 0 rejected")).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole("button", { name: "Push to YOLO" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("YOLO Training Configuration")).toBeVisible();

    await modal.getByRole("checkbox", { name: "Lantana" }).click();
    await modal.getByRole("button", { name: "Start Training" }).click();

    await expect(page.getByText(/YOLO training started!/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "View YOLO Training Progress" })).toBeVisible();
  });

  test("training dashboard can create a dataset and queue a YOLO job", async ({ page }) => {
    await setupMockApi(page);

    let datasetPayload: Record<string, unknown> | null = null;
    let trainingPayload: Record<string, unknown> | null = null;

    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().includes("/api/training/datasets")) {
        datasetPayload = request.postDataJSON() as Record<string, unknown>;
      }
      if (request.url().includes("/api/training/jobs")) {
        trainingPayload = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.goto("/training");

    await expect(page.getByRole("heading", { name: "YOLO Training Dashboard" })).toBeVisible();
    await expect(page.getByText("Service Online")).toBeVisible();

    await page.getByRole("button", { name: "Create Dataset" }).click();
    const datasetDialog = page.getByRole("dialog");
    await expect(datasetDialog.getByText("Create Training Dataset")).toBeVisible();

    await datasetDialog.getByLabel("Dataset name").fill("Autotest Weed Dataset");
    await expect(datasetDialog.getByText("Lantana")).toBeVisible();

    const createDatasetButton = datasetDialog.getByRole("button", { name: "Create Dataset" });
    await createDatasetButton.scrollIntoViewIfNeeded();
    await createDatasetButton.evaluate((button: HTMLButtonElement) => button.click());

    await expect(page.getByText("Dataset created and uploaded to S3.")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => datasetPayload).not.toBeNull();
    expect(datasetPayload?.name).toBe("Autotest Weed Dataset");
    expect(Array.isArray(datasetPayload?.classes)).toBeTruthy();

    await page.getByRole("button", { name: "Start Training" }).first().click();
    const trainingDialog = page.getByRole("dialog");
    await expect(trainingDialog.getByText("Configure your YOLO training job.")).toBeVisible();

    await trainingDialog.getByLabel("Epochs").fill("25");
    await trainingDialog
      .getByRole("button", { name: "Start Training" })
      .evaluate((button: HTMLButtonElement) => button.click());

    await expect(page.getByText("Training job queued. Monitoring progress.")).toBeVisible({
      timeout: 15000,
    });
    await expect.poll(() => trainingPayload).not.toBeNull();
    expect(trainingPayload?.epochs).toBe(25);
    expect(trainingPayload?.baseModel).toBe("yolo11m");

    await expect(page.getByText("Autotest Weed Dataset")).toBeVisible();
    await expect(page.getByText(/Running|Queued/i).first()).toBeVisible();
  });

  test("training dashboard surfaces YOLO instance outage", async ({ page }) => {
    await setupMockApi(page, { trainingAvailable: false });

    await page.goto("/training");

    await expect(page.getByText("Service Offline")).toBeVisible();
    await expect(
      page.getByText(
        "YOLO service is unavailable. Dataset creation is available, but training and model activation are disabled."
      )
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Training" }).first()).toBeDisabled();
  });
});
