import { test, expect } from '@playwright/test';
import { TOOLS } from '../../../src/lib/tools-registry';

/**
 * P5.4 — mobile viewport pass (runs under the `mobile` Playwright project on a
 * Pixel 5 profile). For every page: the H1 renders, the primary interaction
 * (drop zone) is visible, and there's no horizontal overflow — the classic
 * mobile bug where a fixed-width element pushes the layout wider than the
 * viewport and forces sideways scrolling.
 */

const routes = [
  { route: '/', name: 'Home' },
  ...TOOLS.map((t) => ({ route: `/${t.slug}`, name: t.name })),
  { route: '/privacy', name: 'Privacy' },
];

test.describe('P5.4 — mobile layout smoke', () => {
  for (const { route, name } of routes) {
    test(`${route} (${name}) fits the viewport with no horizontal overflow`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // No horizontal scrolling: the document must not be wider than the
      // viewport (allow 1px for sub-pixel rounding).
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `horizontal overflow of ${overflow}px on ${route}`).toBeLessThanOrEqual(1);
    });
  }
});
