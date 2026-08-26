import { test, expect } from '@playwright/test';
import { TOOLS } from '../../../src/lib/tools-registry';
import { collectHeadingSkips } from '../helpers/harness';

/**
 * P4.2 — heading hierarchy (WCAG 1.3.1). Every page must have exactly one H1
 * (the tool/page hero) and no skipped heading levels (e.g. h1 → h3 with no h2).
 * Section headings inside the interactive islands were demoted from h3 to h2 so
 * they sit as peers of the static "How to / Features / FAQ" h2 sections.
 */

const routes = [
  { route: '/', name: 'Home' },
  ...TOOLS.map((t) => ({ route: `/${t.slug}`, name: t.name })),
  { route: '/privacy', name: 'Privacy' },
];

test.describe('P4.2 — heading hierarchy', () => {
  for (const { route, name } of routes) {
    test(`${route} (${name}) has one H1 and no level skips`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const skips = await collectHeadingSkips(page);
      expect(skips, `Heading level skips on ${route}:\n  ${skips.join('\n  ')}`).toEqual([]);
    });
  }
});
