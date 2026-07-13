import { expect, test } from "@playwright/test";

test.describe("Guided Teach AI workspace", () => {
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
});
