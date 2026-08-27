import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { TOOLS } from '../../../src/lib/tools-registry';
import { addSingleFileAndWait } from '../helpers/harness';
import { FIXTURE } from '../fixtures/generate';

/**
 * P4.4 — automated accessibility audit with axe-core. Every page (and the
 * mid-operation processing state) must have **zero serious or critical**
 * WCAG 2.0/2.1 A/AA violations.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function seriousCriticalViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/** Render a violation list into a readable failure message. */
function describe(violations: Awaited<ReturnType<typeof seriousCriticalViolations>>) {
  return violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    e.g. ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
}

const routes = [
  { route: '/', name: 'Home' },
  ...TOOLS.map((t) => ({ route: `/${t.slug}`, name: t.name })),
  { route: '/privacy', name: 'Privacy' },
];

test.describe('P4.4 — axe: zero serious/critical violations', () => {
  for (const { route, name } of routes) {
    test(`${route} (${name})`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const violations = await seriousCriticalViolations(page);
      expect(violations, `axe violations on ${route}:\n${describe(violations)}`).toEqual([]);
    });
  }

  test('mid-operation (compress-pdf processing overlay)', async ({ page }) => {
    // Reduced motion disables the overlay's fade-in outright (global.css sets
    // "animation: none" under prefers-reduced-motion), so its opacity is a
    // deterministic 1 as soon as it mounts. Waiting for the fade to finish
    // instead is a race the app can win: against a production build the
    // operation can complete before the 0.3s animation does.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/compress-pdf');
    await addSingleFileAndWait(page, FIXTURE.pdfPhoto);
    await page.getByTestId('tool-action').click();
    // Scan while the processing overlay is on screen. Contrast must be graded at
    // the steady-state opacity, not a mid-animation blend — see emulateMedia above.
    const overlay = page.getByTestId('processing-overlay');
    await expect(overlay).toBeVisible();
    expect(await overlay.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const violations = await seriousCriticalViolations(page);
    expect(violations, `axe violations mid-operation:\n${describe(violations)}`).toEqual([]);
  });
});
