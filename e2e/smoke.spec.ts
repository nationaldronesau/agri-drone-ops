import { test, expect } from '@playwright/test';

/**
 * Smoke tests - Basic functionality verification
 *
 * These tests verify that core pages load and basic navigation works.
 * They should be fast and run on every commit.
 */

test.describe('Smoke Tests', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/AgriDrone/i);
  });

  test('dashboard loads', async ({ page }) => {
    await page.goto('/test-dashboard');
    await expect(page.locator('text=Dashboard')).toBeVisible();
  });

  test('export page loads', async ({ page }) => {
    await page.goto('/export');
    await expect(page.locator('text=Export Data')).toBeVisible();
  });

  test('upload page loads', async ({ page }) => {
    await page.goto('/upload');
    await expect(page.locator('text=Upload')).toBeVisible();
  });

  test('map page loads', async ({ page }) => {
    await page.goto('/map');
    // Map page should have some map-related content
    await expect(page.locator('text=Map')).toBeVisible();
  });

  test('navigation from dashboard to export', async ({ page }) => {
    await page.goto('/test-dashboard');

    // Find and click export link
    await page.click('a[href="/export"]');

    // Should be on export page
    await expect(page).toHaveURL(/\/export/);
    await expect(page.locator('text=Export Data')).toBeVisible();
  });
});
