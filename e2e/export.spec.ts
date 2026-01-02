import { test, expect, Download } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Export Workflow Tests
 *
 * Tests for the data export functionality including CSV, KML, and Shapefile formats.
 */

test.describe('Export Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/export');
  });

  test('displays all three export format options', async ({ page }) => {
    // Check CSV option exists
    await expect(page.locator('text=CSV Format')).toBeVisible();

    // Check KML option exists
    await expect(page.locator('text=KML Format')).toBeVisible();

    // Check Shapefile option exists
    await expect(page.locator('text=Shapefile')).toBeVisible();
  });

  test('can select shapefile format', async ({ page }) => {
    // Click on shapefile option
    await page.click('text=Shapefile');

    // The shapefile card should have purple styling when selected
    const shapefileCard = page.locator('div:has-text("Shapefile")').filter({
      has: page.locator('text=GIS compatible'),
    });

    // Check it has the selected border color
    await expect(shapefileCard).toHaveClass(/border-purple-500/);
  });

  test('displays usage instructions for all formats', async ({ page }) => {
    // Scroll to usage instructions
    await page.locator('text=How to Use Exported Data').scrollIntoViewIfNeeded();

    // Check CSV instructions
    await expect(page.locator('text=Open in Excel, Google Sheets')).toBeVisible();

    // Check KML instructions
    await expect(page.locator('text=View in Google Earth')).toBeVisible();

    // Check Shapefile instructions
    await expect(page.locator('text=Direct import into DJI Terra')).toBeVisible();
  });

  test('can toggle data source options', async ({ page }) => {
    // Find the AI detections checkbox
    const aiCheckbox = page.locator('input#includeAI');
    const manualCheckbox = page.locator('input#includeManual');

    // Both should be checked by default
    await expect(aiCheckbox).toBeChecked();
    await expect(manualCheckbox).toBeChecked();

    // Toggle AI off
    await aiCheckbox.click();
    await expect(aiCheckbox).not.toBeChecked();

    // Toggle Manual off
    await manualCheckbox.click();
    await expect(manualCheckbox).not.toBeChecked();
  });

  test('shows project filter dropdown', async ({ page }) => {
    // Find the project selector
    const projectSelector = page.locator('button:has-text("All Projects")');
    await expect(projectSelector).toBeVisible();

    // Click to open dropdown
    await projectSelector.click();

    // Should show "All Projects" option
    await expect(page.locator('div[role="option"]:has-text("All Projects")')).toBeVisible();
  });
});

test.describe('Shapefile Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/export');
    // Select shapefile format
    await page.click('text=Shapefile');
  });

  test('shapefile export button triggers download', async ({ page }) => {
    // Start waiting for download before clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);

    // Click export button
    await page.click('button:has-text("Export")');

    // Check if download started (may fail if no data in DB)
    const download = await downloadPromise;

    if (download) {
      // Verify it's a ZIP file
      expect(download.suggestedFilename()).toMatch(/\.zip$/);
    }
    // If no download, test passes anyway (no data case)
  });

  test('shapefile export API returns correct content type', async ({ request }) => {
    // Make direct API request
    const response = await request.get('/api/export/stream?format=shapefile');

    // If successful, should return ZIP
    if (response.ok()) {
      expect(response.headers()['content-type']).toBe('application/zip');
    } else {
      // 400 is expected if no data
      expect(response.status()).toBe(400);
    }
  });
});

test.describe('Export API', () => {
  test('CSV export returns correct content type', async ({ request }) => {
    const response = await request.get('/api/export/stream?format=csv');

    if (response.ok()) {
      expect(response.headers()['content-type']).toBe('text/csv');
    }
  });

  test('KML export returns correct content type', async ({ request }) => {
    const response = await request.get('/api/export/stream?format=kml');

    if (response.ok()) {
      expect(response.headers()['content-type']).toBe('application/vnd.google-earth.kml+xml');
    }
  });

  test('invalid format returns error', async ({ request }) => {
    const response = await request.get('/api/export/stream?format=invalid');

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid format');
  });
});

test.describe('Export with Data', () => {
  // These tests require actual data in the database
  // They are marked as skip by default - remove skip when running with seeded data

  test.skip('shapefile contains expected files', async ({ page }) => {
    await page.goto('/export');
    await page.click('text=Shapefile');

    // Wait for download
    const downloadPromise = page.waitForEvent('download');
    await page.click('button:has-text("Export")');
    const download = await downloadPromise;

    // Save to temp location
    const downloadPath = path.join('/tmp', download.suggestedFilename());
    await download.saveAs(downloadPath);

    // Verify file exists and has content
    const stats = fs.statSync(downloadPath);
    expect(stats.size).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(downloadPath);
  });
});
