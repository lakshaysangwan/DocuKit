import { test, expect } from '@playwright/test';
import { TOOLS } from '../../../src/lib/tools-registry';
import { LANDING_PAGES } from '../../../src/lib/landing-pages';

/**
 * Lakshay's rule: the word "free" never appears in the site's copy — titles,
 * descriptions, headings, FAQs, labels, share-card text — visible or hidden.
 * The no-cost signal lives only in structured data (`offers.price: 0`), so
 * JSON-LD and every other <script> are left out, as are attributes that are
 * data rather than copy (`data-*`, island `props`, URLs).
 *
 * src/lib/landing-pages.test.ts checks the landing-page strings at the source;
 * this checks every built page as served, hydrated islands included.
 */
const FREE = /\bfree\b/i;

const PATHS = [
  '/',
  '/privacy/',
  '/view/',
  ...TOOLS.map((t) => `/${t.slug}/`),
  ...LANDING_PAGES.map((p) => `/${p.slug}/`),
];

/** Every string a visitor, a search result or a share card can show. */
async function copyOnPage(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [document.title];
    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], meta[name="application-name"], meta[name="apple-mobile-web-app-title"]',
    )) {
      if (!/:(image|url)/.test(meta.getAttribute('property') ?? meta.name)) out.push(meta.content);
    }
    // All text in the body, shown or hidden, without scripts and styles.
    const body = document.body.cloneNode(true) as HTMLElement;
    for (const el of body.querySelectorAll('script, style, template')) el.remove();
    out.push(body.textContent ?? '');
    for (const el of document.querySelectorAll('[alt], [title], [aria-label], [aria-description], [placeholder]')) {
      for (const attr of ['alt', 'title', 'aria-label', 'aria-description', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v) out.push(v);
      }
    }
    return out;
  });
}

test.describe('copy never says "free"', () => {
  for (const path of PATHS) {
    test(`${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('load');
      const offenders = (await copyOnPage(page))
        .flatMap((text) => text.split(/(?<=[.!?])\s+|\n+/))
        .filter((line) => FREE.test(line))
        .map((line) => line.trim().slice(0, 200));
      expect(offenders, `"free" in the copy of ${path}`).toEqual([]);
    });
  }

  test('the web app manifest', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    const copy = [manifest.name, manifest.short_name, manifest.description].filter(Boolean);
    expect(copy.filter((t: string) => FREE.test(t))).toEqual([]);
  });

  test('the hidden search words and the share-card text', () => {
    // searchKeywords are never shown but are copy all the same (no hidden
    // keyword text); name and shortDescription are drawn on the share images
    // by scripts/generate-og-images.ts.
    const offenders = [...TOOLS, ...LANDING_PAGES].flatMap((t) =>
      [t.name, t.shortDescription, ...(t.searchKeywords ?? [])]
        .filter((text) => FREE.test(text))
        .map((text) => `${t.slug}: ${text}`));
    expect(offenders).toEqual([]);
  });
});
