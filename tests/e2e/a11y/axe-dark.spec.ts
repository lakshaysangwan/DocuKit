import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { TOOLS } from '../../../src/lib/tools-registry';

/**
 * P5.4 (dark-mode half) — the axe contrast pass in Phase 4 ran in the default
 * light theme. Dark mode uses a separate set of colour tokens (including the
 * success/error and muted overrides added for AA), so re-run axe with the theme
 * forced to dark to prove those tokens also clear serious/critical thresholds.
 *
 * Dark mode is applied by an inline script in BaseLayout that adds `.dark` to
 * <html> when localStorage `docukit-theme` is "dark"; seed it before navigation.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function seriousCritical(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

function describe(violations: Awaited<ReturnType<typeof seriousCritical>>) {
  return violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    e.g. ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
}

const routes = [
  { route: '/', name: 'Home' },
  ...TOOLS.map((t) => ({ route: `/${t.slug}`, name: t.name })),
  { route: '/privacy', name: 'Privacy' },
];

test.describe('P5.4 — axe in dark mode: zero serious/critical', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('docukit-theme', 'dark'));
  });

  for (const { route, name } of routes) {
    test(`${route} (${name})`, async ({ page }) => {
      await page.goto(route);
      // Confirm dark actually applied before scanning.
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const violations = await seriousCritical(page);
      expect(violations, `dark-mode axe violations on ${route}:\n${describe(violations)}`).toEqual([]);
    });
  }
});
