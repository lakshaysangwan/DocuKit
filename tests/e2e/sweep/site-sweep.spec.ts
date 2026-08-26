import { test, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../../../src/lib/tools-registry';
import { gotoTimed } from '../helpers/harness';

/**
 * Site-wide sweep — the data-collection backbone of the UI/UX + performance
 * audit. For every route it records:
 *   • load timing (TTFB, DOM interactive, FCP, DOMContentLoaded, full load)
 *   • console errors / failed (>=500 or non-aborted) network requests
 *   • static accessibility observations (landmarks, headings, alt text,
 *     accessible names, labelled form controls)
 *
 * Findings are written to test-results/audit-sweep.json rather than asserted,
 * because the brief is "report, don't fix" — we don't want a11y/perf findings
 * to fail the suite. Each page only gets a smoke assertion (renders an <h1>).
 */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', '..', '..', 'test-results', 'audit-sweep.json');

type A11y = {
  title: string;
  metaDescription: string | null;
  h1Count: number;
  h1Text: string[];
  hasMain: boolean;
  hasBanner: boolean;
  hasContentinfo: boolean;
  headingSkips: string[];
  imagesMissingAlt: number;
  buttonsMissingName: number;
  linksMissingName: number;
  inputsMissingLabel: number;
  autofocusCount: number;
  langAttr: string | null;
  viewportMeta: boolean;
};

type PageReport = {
  route: string;
  name: string;
  ttfb: number | null;
  domInteractive: number | null;
  fcp: number | null;
  domContentLoaded: number;
  fullLoad: number;
  consoleErrors: string[];
  failedRequests: string[];
  a11y: A11y;
};

const results: PageReport[] = [];

/** Pull static a11y observations from the live DOM. */
async function collectA11y(page: import('@playwright/test').Page): Promise<A11y> {
  return page.evaluate(() => {
    const q = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

    // Heading order — flag any jump that skips a level (e.g. h2 -> h4).
    const headings = q<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6');
    const headingSkips: string[] = [];
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) headingSkips.push(`${'h' + prev} -> ${'h' + level} ("${(h.textContent ?? '').trim().slice(0, 40)}")`);
      prev = level;
    }

    const visible = (el: Element) => {
      const s = getComputedStyle(el as HTMLElement);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    };

    const accessibleName = (el: Element) =>
      (el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        (el as HTMLElement).innerText ||
        el.getAttribute('title') ||
        '').trim();

    const imagesMissingAlt = q<HTMLImageElement>('img').filter((i) => !i.hasAttribute('alt')).length;

    const buttonsMissingName = q<HTMLButtonElement>('button')
      .filter(visible)
      .filter((b) => !accessibleName(b)).length;

    const linksMissingName = q<HTMLAnchorElement>('a[href]')
      .filter(visible)
      .filter((a) => !accessibleName(a)).length;

    const inputsMissingLabel = q<HTMLInputElement>(
      'input:not([type=hidden]):not([type=file]), select, textarea'
    )
      .filter(visible)
      .filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        const id = el.getAttribute('id');
        if (id && document.querySelector(`label[for="${id}"]`)) return false;
        if (el.closest('label')) return false;
        return true;
      }).length;

    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;

    return {
      title: document.title,
      metaDescription: metaDesc,
      h1Count: q('h1').length,
      h1Text: q<HTMLHeadingElement>('h1').map((h) => (h.textContent ?? '').trim()),
      hasMain: !!document.querySelector('main, [role=main]'),
      hasBanner: !!document.querySelector('header, [role=banner]'),
      hasContentinfo: !!document.querySelector('footer, [role=contentinfo]'),
      headingSkips,
      imagesMissingAlt,
      buttonsMissingName,
      linksMissingName,
      inputsMissingLabel,
      autofocusCount: q('[autofocus]').length,
      langAttr: document.documentElement.getAttribute('lang'),
      viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    };
  });
}

const routes: { route: string; name: string }[] = [
  { route: '/', name: 'Home' },
  ...TOOLS.map((t) => ({ route: `/${t.slug}`, name: t.name })),
  { route: '/privacy', name: 'Privacy' },
];

test.describe('Site sweep — load metrics + a11y + errors', () => {
  // Serial so all pages run in one worker: the shared `results` array and the
  // single afterAll JSON write only aggregate correctly within one process.
  test.describe.configure({ mode: 'serial' });

  for (const { route, name } of routes) {
    test(`sweep ${route} (${name})`, async ({ page }) => {
      const timing = await gotoTimed(page, route);
      // Give client islands a beat to hydrate so console errors surface.
      await page.waitForLoadState('networkidle').catch(() => {});
      const a11y = await collectA11y(page);

      results.push({
        route,
        name,
        ttfb: timing.ttfb,
        domInteractive: timing.domInteractive,
        fcp: timing.fcp,
        domContentLoaded: timing.domContentLoaded,
        fullLoad: timing.fullLoad,
        consoleErrors: timing.diag.meaningfulConsoleErrors,
        failedRequests: timing.diag.failedRequests,
        a11y,
      });

      // Smoke assertion only — everything else is reported, not enforced.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test.afterAll(async () => {
    await mkdir(path.dirname(OUT), { recursive: true });
    // Sort slowest-first to make the perf section of the report easy to read.
    results.sort((a, b) => b.fullLoad - a.fullLoad);
    await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), pages: results }, null, 2));
  });
});
