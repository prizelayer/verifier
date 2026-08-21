import { expect, test } from '@playwright/test';

/**
 * Load the published artifact the way a stranger would — a plain ES module import in a page — and
 * make it reproduce the whole fixture using the browser's own crypto.
 */
test('reproduces every golden vector in this browser engine', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/test/browser/index.html');
  await page.waitForFunction(() => (window as any).__conformance !== undefined, null, {
    timeout: 30_000,
  });

  const result = await page.evaluate(() => (window as any).__conformance);

  expect(pageErrors, 'the page must not raise').toEqual([]);
  expect(result.failures, 'every vector must reproduce').toEqual([]);
  // A guard against the harness silently checking nothing — a fetch that 404s into an empty
  // fixture would otherwise report zero failures and look like a pass.
  expect(result.checked).toBeGreaterThan(300);
});
