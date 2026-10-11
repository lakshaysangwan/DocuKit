import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { TOOLS } from '../../../src/lib/tools-registry';
import { LANDING_PAGES } from '../../../src/lib/landing-pages';
import { PageDiagnostics } from '../helpers/harness';

/**
 * Homepage search — type to jump to a tool or a task page.
 *
 * The ranking itself is unit-tested (src/lib/tool-search.test.ts). These cover
 * what only a browser can show: that the index built into the page reaches the
 * island, that the results are real links to the URLs the site serves, that the
 * keyboard and a screen reader can drive it, that it never moves the page, and
 * that the homepage is unchanged for a visitor without JavaScript.
 */

/** Open the homepage and wait until the search island is wired up. */
async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="tool-search"][data-hydrated="true"]')).toBeVisible();
  return page.getByRole('combobox', { name: 'Search tools' });
}

/** The first card in the grid — not the search result that links to the same page. */
const FIRST_CARD = '#tools a[href="/merge-pdf/"]:not([role="option"])';

/** An element's distance from the top of the document, however far the page is scrolled. */
async function documentTop(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
}

test.describe('Homepage search', () => {
  test('typing finds a tool and links to it', async ({ page }) => {
    const input = await openHome(page);
    await expect(input).toHaveAttribute('aria-expanded', 'false');

    await input.pressSequentially('merge');

    const first = page.getByRole('option').first();
    await expect(first).toContainText('Merge PDF');
    await expect(first).toHaveAttribute('href', '/merge-pdf/');
    await expect(first).toHaveAttribute('aria-selected', 'true');

    // Combobox wiring: expanded, pointing at its listbox and the highlighted option.
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.getByRole('listbox', { name: 'Matching tools' });
    await expect(listbox).toBeVisible();
    expect(await input.getAttribute('aria-controls')).toBe(await listbox.getAttribute('id'));
    expect(await input.getAttribute('aria-activedescendant')).toBe(await first.getAttribute('id'));
  });

  test('typing finds a task page, including by another spelling of its format', async ({ page }) => {
    const input = await openHome(page);

    await input.fill('heic');
    await expect(page.getByRole('option').first()).toContainText('HEIC to JPG');
    await expect(page.getByRole('option').first()).toHaveAttribute('href', '/heic-to-jpg/');

    // The task page first, then the tool it is a preset of.
    await input.fill('pdf to jpg');
    await expect(page.getByRole('option').nth(0)).toHaveAttribute('href', '/pdf-to-jpg/');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute('href', '/pdf-to-image/');

    await input.fill('PDF to JPEG');
    await expect(page.getByRole('option').nth(0)).toHaveAttribute('href', '/pdf-to-jpg/');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute('href', '/pdf-to-image/');
  });

  test('covers every tool and task page, each linked with a trailing slash', async ({ page }) => {
    const input = await openHome(page);
    const pages = [...TOOLS, ...LANDING_PAGES];

    // "p" is in every page's name or keyword (pdf, png, photo, picture, password, page…)
    // — if that stops being true this fails loudly rather than under-testing.
    await input.fill('p');
    const hrefs = await page.getByRole('option').evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    expect([...hrefs].sort()).toEqual(pages.map((p) => `/${p.slug}/`).sort());
    await expect(page.getByTestId('tool-search-status')).toHaveText(`${pages.length} results`);
  });

  test('arrow keys move through the results and Enter opens the chosen one', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('compress pdf');

    const options = page.getByRole('option');
    await expect(options.nth(0)).toHaveAttribute('href', '/compress-pdf/');
    await expect(options.nth(1)).toHaveAttribute('href', '/compress-pdf-to-100kb/');
    const count = await options.count();

    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    expect(await input.getAttribute('aria-activedescendant')).toBe(await options.nth(1).getAttribute('id'));

    // Wraps at both ends, and focus never leaves the field.
    await input.press('ArrowUp');
    await input.press('ArrowUp');
    await expect(options.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();

    await input.press('Enter');
    await expect(page).toHaveURL(/\/compress-pdf-to-100kb\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compress a PDF to 100KB');
  });

  test('Enter straight after typing opens the top result', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('rotate');
    await expect(page.getByRole('option').first()).toHaveAttribute('href', '/rotate-pdf/');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/rotate-pdf\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rotate PDF Pages');
  });

  test('clicking a result opens it', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('watermark');
    await page.getByRole('option', { name: /^Watermark PDF/ }).click();
    await expect(page).toHaveURL(/\/watermark-pdf\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add Watermark to PDF');
  });

  test('Escape closes the results, then clears the field', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('sign');
    const listbox = page.getByRole('listbox', { name: 'Matching tools' });
    await expect(listbox).toBeVisible();

    await input.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toHaveValue('sign');

    // Arrow down brings the same results back without retyping.
    await input.press('ArrowDown');
    await expect(listbox).toBeVisible();
    await input.press('Escape');

    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });

  test('the clear button empties the field and keeps the cursor in it', async ({ page }) => {
    const input = await openHome(page);
    await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
    await input.fill('crop');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(page.getByRole('listbox', { name: 'Matching tools' })).toBeHidden();
  });

  test('"/" and Ctrl+K move the cursor into the field', async ({ page }) => {
    const input = await openHome(page);
    await expect(input).not.toBeFocused();

    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    // The key focused the field; it was not typed into it.
    await expect(input).toHaveValue('');

    // Inside the field "/" is just a character.
    await page.keyboard.press('/');
    await expect(input).toHaveValue('/');

    await input.fill('');
    await input.blur();
    await expect(input).not.toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(input).toBeFocused();
  });

  test('says so when nothing matches, and Enter goes nowhere', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('spreadsheet');

    const empty = page.getByTestId('tool-search-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No tools match “spreadsheet”');
    // Announced to a screen reader through the live region, not only shown.
    const status = page.getByTestId('tool-search-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveText('No tools match spreadsheet');

    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(input).toHaveAttribute('aria-expanded', 'false');

    await input.press('Enter');
    await expect(empty).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(new URL(page.url()).pathname).toBe('/');

    // Correcting the query brings results straight back.
    await input.fill('merge');
    await expect(empty).toBeHidden();
    await expect(status).toHaveText(/^\d+ results?$/);
  });

  test('the suggestions in the "no results" message each find something', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('spreadsheet');
    const hint = await page.getByTestId('tool-search-empty').locator('p').nth(1).innerText();
    const suggestions = [...hint.matchAll(/“([^”]+)”/g)].map((m) => m[1]);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      await input.fill(suggestion);
      await expect(page.getByRole('option').first(), `"${suggestion}"`).toBeVisible();
    }
  });

  test('leaving the field closes the results', async ({ page }) => {
    const input = await openHome(page);
    await input.fill('resize');
    const listbox = page.getByRole('listbox', { name: 'Matching tools' });
    await expect(listbox).toBeVisible();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(listbox).toBeHidden();
    // The query is still there, and focusing the field shows its results again.
    await input.focus();
    await expect(listbox).toBeVisible();
  });

  test('runs under the production CSP with no errors and no request for results', async ({ page }) => {
    // Tall enough that the results fit under the field. In a shorter window the
    // page scrolls to show them, and the site prefetches whichever tool cards
    // scroll into view — real requests, but nothing to do with searching.
    await page.setViewportSize({ width: 1280, height: 1400 });
    const diag = new PageDiagnostics(page);
    const input = await openHome(page);
    // Idle islands and the first screen's prefetches are part of loading.
    await page.waitForLoadState('networkidle');

    const requests: { method: string; url: string; body: string }[] = [];
    page.on('request', (req) => requests.push({ method: req.method(), url: req.url(), body: req.postData() ?? '' }));
    await input.pressSequentially('pdf to jpg');
    await expect(page.getByRole('option').first()).toHaveAttribute('href', '/pdf-to-jpg/');
    await input.fill('spreadsheet');
    await expect(page.getByTestId('tool-search-empty')).toBeVisible();

    // Searching is done in the page: nothing is asked for results, and what was
    // typed goes nowhere. The one thing typing can set off is the site's own link
    // prefetch — a result that stays on screen is a link like any other, so its
    // page may be fetched ahead of a click. That is a plain GET of a page of this
    // site, naming the page and never the words typed.
    const origin = new URL(page.url()).origin;
    const pagePaths = new Set([...TOOLS, ...LANDING_PAGES].map((p) => `/${p.slug}/`));
    const isPagePrefetch = (r: { method: string; url: string; body: string }) => {
      const url = new URL(r.url);
      return r.method === 'GET' && !r.body && url.origin === origin && !url.search && !url.hash && pagePaths.has(url.pathname);
    };
    const listed = requests.map((r) => `${r.method} ${r.url}`).join('\n');
    expect(
      requests.filter((r) => !isPagePrefetch(r)).map((r) => `${r.method} ${r.url}`),
      `requests made while typing, other than prefetches of this site's pages:\n${listed}`,
    ).toEqual([]);

    // What was typed, in the forms a URL or a request body could carry it.
    const typed = ['pdf to jpg', 'spreadsheet'].flatMap((q) => [q, q.replaceAll(' ', '+'), encodeURIComponent(q)]);
    const carriers = requests.filter((r) => {
      const url = new URL(r.url);
      const sent = `${url.search}${url.hash}${r.body}`.toLowerCase();
      return typed.some((q) => sent.includes(q.toLowerCase()));
    });
    expect(carriers.map((r) => `${r.method} ${r.url}`), 'requests carrying the typed text').toEqual([]);
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });
});

test.describe('Homepage search — the page does not move', () => {
  // The first test holds back the island's script with page.route(), which a
  // service worker's own fetches would slip past.
  test.use({ serviceWorkers: 'block' });

  test('hydrating the search leaves the field and the grid where the server put them', async ({ page }) => {
    // First load: block the island's script, so this is the layout before hydration.
    await page.route('**/_astro/ToolSearch.*.js', (route) => route.abort());
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const search = page.getByTestId('tool-search');
    await expect(search).toHaveAttribute('data-hydrated', 'false');
    const before = {
      field: await page.getByRole('combobox', { name: 'Search tools' }).boundingBox(),
      heading: await documentTop(page, '#tools-heading'),
      firstCard: await documentTop(page, FIRST_CARD),
    };

    await page.unroute('**/_astro/ToolSearch.*.js');
    const input = await openHome(page);
    const after = {
      field: await input.boundingBox(),
      heading: await documentTop(page, '#tools-heading'),
      firstCard: await documentTop(page, FIRST_CARD),
    };

    expect(after).toEqual(before);
  });

  test('results and the "no results" message open over the grid, not above it', async ({ page }) => {
    const input = await openHome(page);
    const heading = await documentTop(page, '#tools-heading');
    const firstCard = await documentTop(page, FIRST_CARD);

    await input.fill('pdf');
    await expect(page.getByRole('listbox', { name: 'Matching tools' })).toBeVisible();
    expect(await documentTop(page, '#tools-heading')).toBe(heading);
    expect(await documentTop(page, FIRST_CARD)).toBe(firstCard);

    await input.fill('spreadsheet');
    await expect(page.getByTestId('tool-search-empty')).toBeVisible();
    expect(await documentTop(page, '#tools-heading')).toBe(heading);
    expect(await documentTop(page, FIRST_CARD)).toBe(firstCard);
  });

  test('the results are brought into view when they would open below the fold', async ({ page }) => {
    // A short window: the field is on screen but there is no room under it.
    await page.setViewportSize({ width: 1280, height: 620 });
    const input = await openHome(page);
    await input.fill('pdf');

    const listbox = page.getByRole('listbox', { name: 'Matching tools' });
    await expect(listbox).toBeInViewport({ ratio: 1 });
    await expect(input).toBeInViewport({ ratio: 1 });
  });
});

test.describe('Homepage search — before it has loaded', () => {
  // page.route() holds the island's script back; a service worker's own fetches would slip past it.
  test.use({ serviceWorkers: 'block' });

  test('text typed into the field early is searched as soon as the search loads', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/_astro/ToolSearch.*.js', async (route) => {
      await held;
      await route.continue();
    });

    // Not the default 'load': a browser may ask for the island's script before
    // load fires (Firefox sometimes does), and load would then wait on the very
    // request this test is holding back.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const search = page.getByTestId('tool-search');
    const input = page.getByRole('combobox', { name: 'Search tools' });
    await input.click();
    await input.pressSequentially('merge');
    // Nothing is listening yet: the text is in the field and that is all.
    await expect(search).toHaveAttribute('data-hydrated', 'false');
    await expect(page.getByRole('option')).toHaveCount(0);

    release();
    await expect(search).toHaveAttribute('data-hydrated', 'true');
    await expect(input).toHaveValue('merge');
    await expect(page.getByRole('option').first()).toHaveAttribute('href', '/merge-pdf/');
  });
});

test.describe('Homepage search — accessibility', () => {
  const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  async function seriousCritical(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `[${v.impact}] ${v.id}: ${v.help} — ${v.nodes[0]?.target.join(' ')}`);
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`axe finds nothing serious with results open and with none found (${theme})`, async ({ page }) => {
      if (theme === 'dark') {
        await page.addInitScript(() => localStorage.setItem('docukit-theme', 'dark'));
      }
      const input = await openHome(page);
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);

      await input.fill('image');
      await expect(page.getByRole('option').first()).toBeVisible();
      await input.press('ArrowDown');
      expect(await seriousCritical(page)).toEqual([]);

      await input.fill('spreadsheet');
      await expect(page.getByTestId('tool-search-empty')).toBeVisible();
      expect(await seriousCritical(page)).toEqual([]);
    });
  }

  test('the field is labelled and describes how to use it', async ({ page }) => {
    const input = await openHome(page);
    await expect(input).toHaveAccessibleName('Search tools');
    await expect(input).toHaveAccessibleDescription(/arrow keys/);
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(page.getByRole('search', { name: 'Tools' })).toBeVisible();
  });
});

test.describe('Homepage without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('still shows the full tool grid', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Every tool, in registry order (PDF tools, then image tools), linked as before.
    const expected = [
      ...TOOLS.filter((t) => t.category === 'pdf'),
      ...TOOLS.filter((t) => t.category === 'image'),
    ];
    const cards = page.locator('#tools a[href]');
    await expect(cards).toHaveCount(expected.length);
    expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute('href'))))
      .toEqual(expected.map((t) => `/${t.slug}/`));
    for (const tool of expected) {
      const card = page.locator(`#tools a[href="/${tool.slug}/"]`);
      await expect(card).toBeVisible();
      await expect(card.getByRole('heading', { level: 3 })).toHaveText(tool.name);
      await expect(card).toContainText(tool.shortDescription);
    }
  });

  // Kept apart from the grid check above: this one rests on the browser applying
  // `@media (scripting: none)`, so if an engine ever disagrees, the failure says
  // "the field was left showing", not "the grid is gone".
  test('removes the search field, which could not work, and the space it took', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByTestId('tool-search')).toBeHidden();
    // With it gone the section starts with the grid's own heading, as it always has.
    const sectionTop = await documentTop(page, '#tools');
    expect(await documentTop(page, '#tools-heading') - sectionTop).toBeLessThan(8);
  });
});
