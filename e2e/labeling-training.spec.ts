import { expect, test } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

test.describe("Labeling And Training", () => {
  test("review labeling flow can accept items and start quick training", async ({ page }) => {
    await setupMockApi(page);

    await page.goto("/review?sessionId=review-1");
    await expect(page.getByText("Review Session")).toBeVisible();
    await expect(page.getByText("1 pending · 1 accepted · 0 rejected · 1 export-ready")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Accept filtered \(1\)/ }).click();

    await expect(page.getByText("0 pending · 2 accepted · 0 rejected · 2 export-ready")).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole("button", { name: "Train model", exact: true }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("Training Dataset Setup")).toBeVisible();

    await modal.getByRole("checkbox", { name: "Lantana" }).click();
    await modal.getByRole("button", { name: "Start Training" }).click();

    await expect(page.getByText(/Training started!/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "View training progress" })).toBeVisible();
  });

  test("training workspace can create a dataset and queue a training job", async ({ page }) => {
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

    await expect(page.getByRole("heading", { name: "Training Workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
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
    const createdDatasetPayload = datasetPayload as unknown as Record<string, unknown>;
    expect(createdDatasetPayload.name).toBe("Autotest Weed Dataset");
    expect(Array.isArray(createdDatasetPayload.classes)).toBeTruthy();

    await page.getByRole("button", { name: "Start Training" }).first().click();
    const trainingDialog = page.getByRole("dialog");
    await expect(trainingDialog.getByText("Configure your training run.")).toBeVisible();

    await trainingDialog.getByLabel("Epochs").fill("25");
    await trainingDialog
      .getByRole("button", { name: "Start Training" })
      .evaluate((button: HTMLButtonElement) => button.click());

    await expect(page.getByText("Training job queued. Monitoring progress.")).toBeVisible({
      timeout: 15000,
    });
    await expect.poll(() => trainingPayload).not.toBeNull();
    const queuedTrainingPayload = trainingPayload as unknown as Record<string, unknown>;
    expect(queuedTrainingPayload.epochs).toBe(25);
    expect(queuedTrainingPayload.baseModel).toBe("yolo11m");

    await expect(page.getByText("Autotest Weed Dataset")).toBeVisible();
    await expect(page.getByText(/Running|Queued/i).first()).toBeVisible();
  });

  test("training workspace surfaces model runtime outage", async ({ page }) => {
    await setupMockApi(page, { trainingAvailable: false });

    await page.goto("/training");

    await expect(page.getByText("Service Offline")).toBeVisible();
    await expect(
      page.getByText(
        "Model runtime is unavailable. Dataset creation is available, but training and model activation are disabled."
      )
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Training" }).first()).toBeDisabled();
  });
});
