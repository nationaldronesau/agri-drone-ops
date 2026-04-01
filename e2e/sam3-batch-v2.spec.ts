import { expect, test } from "@playwright/test";
import { setupMockApi } from "./helpers/mock-api";

async function drawFewShotBox(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Few-Shot" }).click();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Canvas bounding box unavailable");
  }

  const startX = box.x + box.width * 0.25;
  const startY = box.y + box.height * 0.25;
  const endX = box.x + box.width * 0.45;
  const endY = box.y + box.height * 0.45;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  await page.mouse.up();

  await expect(page.getByText(/exemplar drawn/i)).toBeVisible();
}

test.describe("SAM3 Pipeline v2", () => {
  test("submits a visual crop match batch through the v2 endpoint and shows stage tracking", async ({ page }) => {
    await setupMockApi(page);

    let requestPayload: Record<string, unknown> | null = null;
    await page.route("**/api/sam3/v2/batch", async (route) => {
      requestPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          success: true,
          batchJobId: "batch-v2-1",
          version: 2,
          mode: "visual_crop_match",
          status: "QUEUED",
          totalImages: 2,
          pollUrl: "/api/sam3/v2/batch/batch-v2-1",
        },
      });
    });

    await page.goto("/annotate/asset-1");
    await drawFewShotBox(page);

    await page.getByRole("checkbox", { name: "Use visual crops only (skip concept propagation)" }).click();
    await page.getByRole("checkbox", { name: "Use cleared SAM3 Pipeline v2" }).click();
    await page.getByRole("button", { name: /Apply to All 2 Images/i }).click();

    await expect.poll(() => requestPayload).not.toBeNull();
    const payload = requestPayload as unknown as Record<string, unknown>;
    expect(payload.mode).toBe("visual_crop_match");
    expect(Array.isArray(payload.exemplarCrops)).toBe(true);

    await expect(page.getByText(/Stage: terminal/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/1 success/i)).toBeVisible();
    await expect(page.getByText(/1 failed/i)).toBeVisible();
  });

  test("submits concept propagation through v2 and surfaces rejected_preflight errors", async ({ page }) => {
    await setupMockApi(page);

    let requestPayload: Record<string, unknown> | null = null;
    await page.route("**/api/sam3/v2/batch", async (route) => {
      requestPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          success: true,
          batchJobId: "batch-v2-reject",
          version: 2,
          mode: "concept_propagation",
          status: "QUEUED",
          totalImages: 2,
          pollUrl: "/api/sam3/v2/batch/batch-v2-reject",
        },
      });
    });
    await page.route("**/api/sam3/v2/batch/batch-v2-reject?includeAnnotations=false", async (route) => {
      await route.fulfill({
        json: {
          success: true,
          batchJob: {
            id: "batch-v2-reject",
            projectId: "proj-1",
            projectName: "North Farm Survey",
            weedType: "Lantana",
            version: 2,
            mode: "concept_propagation",
            status: "FAILED",
            totalImages: 2,
            processedImages: 0,
            detectionsFound: 0,
            errorMessage: "GPU busy (held by another process), retry later.",
            stageLog: [
              {
                stage: "admit",
                status: "failed",
                timestamp: "2026-03-31T00:00:00.000Z",
                errorCode: "GPU_BUSY",
                errorMessage: "GPU busy (held by another process), retry later.",
              },
              {
                stage: "terminal",
                status: "failed",
                terminalState: "rejected_preflight",
                timestamp: "2026-03-31T00:00:01.000Z",
              },
            ],
            latestStage: "terminal",
            terminalState: "rejected_preflight",
            assetSummary: {
              success: 0,
              zero_detections: 0,
              oom: 0,
              inference_error: 0,
              prepare_error: 0,
            },
            createdAt: "2026-03-31T00:00:00.000Z",
            startedAt: "2026-03-31T00:00:00.000Z",
            completedAt: "2026-03-31T00:00:01.000Z",
            completedWithWarnings: false,
          },
          summary: {
            total: 0,
            pending: 0,
            accepted: 0,
            rejected: 0,
          },
          annotations: [],
        },
      });
    });

    await page.goto("/annotate/asset-1");
    await drawFewShotBox(page);

    await page.getByRole("checkbox", { name: "Use cleared SAM3 Pipeline v2" }).click();
    await page.getByRole("button", { name: /Apply to All 2 Images/i }).click();

    await expect.poll(() => requestPayload).not.toBeNull();
    const payload = requestPayload as unknown as Record<string, unknown>;
    expect(payload.mode).toBe("concept_propagation");
    await expect(page.getByText(/GPU busy \(held by another process\), retry later\./i)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/rejected preflight/i)).toBeVisible();
  });
});
