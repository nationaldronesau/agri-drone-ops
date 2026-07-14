import { expect, test } from "@playwright/test";

const projectId = "cproject00000000000000000000";
const assetIds = Array.from({ length: 4 }, (_, index) => `casset00000000000000000000${index}`);

async function mockTeachProject(page: import("@playwright/test").Page) {
  await page.route("**/api/projects?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [{ id: projectId, name: "Lifecycle Test", _count: { assets: assetIds.length } }] }),
    });
  });
  await page.route("**/api/assets?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assets: assetIds.map((id, index) => ({
          id,
          fileName: `Lifecycle_${index + 1}.jpg`,
          storageUrl: "/demo/lantana-batch-aerial.jpg",
          imageWidth: 1536,
          imageHeight: 1024,
        })),
      }),
    });
  });
  await page.route("**/api/assets/*/signed-url", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "/demo/lantana-batch-aerial.jpg", storageType: "local" }),
    });
  });
}

test.describe("Guided Teach AI workspace", () => {
  test("defaults to the first project that contains images", async ({ page }) => {
    const emptyProjectId = "cproject00000000000000000001";
    await page.route("**/api/projects?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [
            { id: emptyProjectId, name: "Empty New Project", _count: { assets: 0 } },
            { id: projectId, name: "Project With Images", _count: { assets: assetIds.length } },
          ],
        }),
      });
    });
    await page.route("**/api/assets?**", async (route) => {
      const requestedProjectId = new URL(route.request().url()).searchParams.get("projectId");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          assets: requestedProjectId === projectId
            ? assetIds.map((id, index) => ({
                id,
                fileName: `Default_${index + 1}.jpg`,
                storageUrl: "/demo/lantana-batch-aerial.jpg",
                imageWidth: 1536,
                imageHeight: 1024,
              }))
            : [],
        }),
      });
    });
    await page.route("**/api/assets/*/signed-url", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "/demo/lantana-batch-aerial.jpg", storageType: "local" }),
      });
    });

    await page.goto("/teach");

    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(projectId);
    await expect(page.getByText("Batch images (4)")).toBeVisible();
  });

  test("marks examples and queues a review-gated demo search", async ({ page }) => {
    await page.goto("/teach?demo=1");

    await expect(page.getByRole("heading", { name: "What should we find?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Teach AI" })).toBeVisible();
    await expect(page.getByText("Batch images (146)")).toBeVisible();

    const filmstrip = page.getByTestId("teach-filmstrip");
    await expect.poll(() => filmstrip.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.getByRole("button", { name: "Next images" }).click();
    await expect.poll(() => filmstrip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    const searchButton = page.getByRole("button", { name: "Search this batch (146)" });
    await expect(searchButton).toBeDisabled();

    const canvas = page.getByTestId("teach-image-canvas");
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const examples = [
      [0.14, 0.43, 0.23, 0.57],
      [0.35, 0.49, 0.44, 0.64],
      [0.53, 0.35, 0.61, 0.49],
    ];

    for (const [x1, y1, x2, y2] of examples) {
      await page.mouse.move(bounds.x + bounds.width * x1, bounds.y + bounds.height * y1);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * x2, bounds.y + bounds.height * y2, { steps: 5 });
      await page.mouse.up();
    }

    await expect(page.getByText("3 of 3–8 examples marked")).toBeVisible();
    await expect(searchButton).toBeEnabled();
    await searchButton.click();
    await expect(page.getByText("Demo batch queued. In a signed-in project, every suggestion will wait in Review.")).toBeVisible();
  });

  test("supports keyboard example marking", async ({ page }) => {
    await page.goto("/teach?demo=1");
    const canvas = page.getByRole("region", { name: "Example marking canvas" });
    await canvas.focus();
    await canvas.press("Enter");
    for (let index = 0; index < 4; index += 1) await canvas.press("ArrowRight");
    for (let index = 0; index < 4; index += 1) await canvas.press("ArrowDown");
    await canvas.press("Enter");
    await expect(page.getByText("1 of 3–8 examples marked")).toBeVisible();
  });

  test("restores a live job, reports execution truth, and opens its exact review session", async ({ page }) => {
    await mockTeachProject(page);
    let statusCalls = 0;
    let reviewPayload: Record<string, unknown> | null = null;

    await page.route("**/api/sam3/v2/batch", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          batchJobId: "cbatch000000000000000000000",
          pollUrl: "/api/sam3/v2/batch/cbatch000000000000000000000",
          mode: "concept_propagation",
          status: "QUEUED",
          totalImages: 4,
        }),
      });
    });
    await page.route("**/api/sam3/v2/batch/cbatch000000000000000000000?includeAnnotations=false", async (route) => {
      statusCalls += 1;
      const completed = statusCalls > 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          batchJob: {
            id: "cbatch000000000000000000000",
            projectId,
            weedType: "Lantana",
            mode: "concept_propagation",
            status: completed ? "COMPLETED" : "PROCESSING",
            processedImages: completed ? 4 : 2,
            totalImages: 4,
            detectionsFound: completed ? 18 : 7,
            latestStage: completed ? "terminal" : "run_sam3",
            terminalState: completed ? "completed" : null,
            completedWithWarnings: false,
          },
          summary: { total: 18, pending: 18, accepted: 0, rejected: 0 },
          execution: {
            providerRoute: "aws_sam3_v2_direct",
            providerLabel: "AWS SAM3",
            pipeline: "sam3_dino_concept",
            pipelineLabel: "SAM3 + DINO concept propagation",
            externalProviderFallback: false,
            runtimeConfirmed: true,
            reviewProfile: "high_recall",
            backendModes: ["concept_ensemble_refined"],
            candidateExpansionAssets: 1,
            refinementFallbackAssets: 0,
            degradedAssets: 1,
            warnings: [],
          },
        }),
      });
    });
    await page.route("**/api/review", async (route) => {
      reviewPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "creview00000000000000000000" } }),
      });
    });

    await page.goto("/teach");
    const canvas = page.getByTestId("teach-image-canvas");
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) return;
    for (const offset of [0.2, 0.4, 0.6]) {
      await page.mouse.move(bounds.x + bounds.width * offset, bounds.y + bounds.height * 0.35);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * (offset + 0.07), bounds.y + bounds.height * 0.47);
      await page.mouse.up();
    }
    await page.getByRole("button", { name: "Search this batch (4)" }).click();
    await expect(page.getByText("Searching image 3 of 4")).toBeVisible();

    const storedRun = await page.evaluate(() => window.localStorage.getItem("agri:teach-batch-run:v1"));
    expect(storedRun).toContain("cbatch000000000000000000000");

    await page.reload();
    await expect(page.getByText("Ready for review", { exact: true })).toBeVisible();
    await page.getByText("Technical details").click();
    await expect(page.getByText(/SAM3 \+ DINO concept propagation/)).toBeVisible();
    await expect(page.getByText(/None — no YOLO or Roboflow provider fallback/)).toBeVisible();
    await expect(page.getByText(/Same-model recovery used on 1 image/)).toBeVisible();

    await page.getByRole("button", { name: "Review these suggestions" }).click();
    await expect(page).toHaveURL(/\/review\?sessionId=creview00000000000000000000/);
    expect(reviewPayload).toMatchObject({
      projectId,
      workflowType: "batch_review",
      weedTypeFilter: "Lantana",
      batchJobIds: ["cbatch000000000000000000000"],
    });
  });

  test("lets an operator discard an inaccessible restored job", async ({ page }) => {
    await mockTeachProject(page);
    await page.addInitScript(({ key, run }) => {
      window.localStorage.setItem(key, JSON.stringify(run));
    }, {
      key: "agri:teach-batch-run:v1",
      run: {
        batchJobId: "cbatch000000000000000000009",
        pollUrl: "/api/sam3/v2/batch/cbatch000000000000000000009",
        projectId,
        target: "Lantana",
        submittedAt: "2026-07-13T00:00:00.000Z",
      },
    });
    await page.route("**/api/sam3/v2/batch/cbatch000000000000000000009?includeAnnotations=false", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Access denied for this saved search." }),
      });
    });

    await page.goto("/teach");
    await expect(page.getByText("Access denied for this saved search.")).toBeVisible();
    await page.getByRole("button", { name: "Discard saved search" }).click();
    await expect(page.getByText("Previous search cleared. Your examples are ready to use again.")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("agri:teach-batch-run:v1"))).toBeNull();
  });
});
