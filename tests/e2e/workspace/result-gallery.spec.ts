import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addSingleFileAndWait } from '../helpers/harness';
import { openOptions } from '../helpers/pdf-to-image';
import { openResize, setSize } from '../helpers/resize-image';

/**
 * The shared result gallery (`MultiFileDownload`) sits in the workspace's
 * narrow controls pane (320–380 px). Its columns follow the width of that
 * pane, not the viewport: the cards stay wide enough to read and nothing
 * scrolls sideways. Measured on a PDF tool and an image tool, at a desktop
 * width and at a phone width.
 */

/** Narrowest a card may get before its name and button stop being usable. */
const MIN_CARD = 130;

async function measure(page: Page) {
  const gallery = page.getByTestId('result-gallery');
  await expect(gallery).toBeVisible();
  await gallery.scrollIntoViewIfNeeded();
  return page.evaluate(() => {
    const g = document.querySelector('[data-testid="result-gallery"]')!;
    const list = g.querySelector('ul')!;
    const cards = [...g.querySelectorAll<HTMLElement>('[data-testid="result-card"]')];
    const controls = document.querySelector<HTMLElement>('[data-testid="ws-controls"]')!;
    const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    return {
      widths: cards.map((c) => c.getBoundingClientRect().width),
      columns: cards.length / tops.size,
      listOverflow: list.scrollWidth - list.clientWidth,
      controlsOverflow: controls.scrollWidth - controls.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      names: [...g.querySelectorAll<HTMLElement>('[data-testid="result-name"]')].map((n) => ({
        text: n.textContent,
        title: n.getAttribute('title'),
      })),
      buttonHeights: [...g.querySelectorAll<HTMLElement>('[data-testid="result-download"]')].map(
        (b) => b.getBoundingClientRect().height,
      ),
      inControls: controls.contains(g),
    };
  });
}

function expectFits(m: Awaited<ReturnType<typeof measure>>, count: number) {
  expect(m.inControls).toBe(true);
  expect(m.widths).toHaveLength(count);
  for (const w of m.widths) expect(w).toBeGreaterThanOrEqual(MIN_CARD);
  expect(m.columns).toBeLessThanOrEqual(2);
  expect(m.listOverflow).toBeLessThanOrEqual(0);
  expect(m.controlsOverflow).toBeLessThanOrEqual(0);
  expect(m.pageOverflow).toBeLessThanOrEqual(0);
  // The full name is always one hover / long-press away, even when the card cuts it short.
  for (const n of m.names) expect(n.title).toBe(n.text);
}

async function pdfToImage(page: Page) {
  await page.goto('/pdf-to-image');
  await addSingleFileAndWait(page, FIXTURE.pdf3page);
  await expect(page.getByTestId('tool-action')).toBeEnabled({ timeout: 20_000 });
  await openOptions(page);
  await page.getByRole('button', { name: '72 DPI (screen)' }).click();
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('result-card')).toHaveCount(3, { timeout: 45_000 });
}

async function resizeBatch(page: Page) {
  await openResize(page, [FIXTURE.jpg, FIXTURE.jpg2, FIXTURE.png]);
  await setSize(page, 300, 300);
  await page.getByTestId('tool-action').click();
  await expect(page.getByTestId('result-card')).toHaveCount(3, { timeout: 60_000 });
}

for (const size of [
  { name: 'desktop 1280', width: 1280, height: 800, touch: false },
  { name: 'desktop 1920', width: 1920, height: 1080, touch: false },
  { name: 'phone 375', width: 375, height: 800, touch: true },
]) {
  test.describe(`Result gallery in the workspace pane — ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });
    // Firefox has no mobile emulation; the phone case runs on the other engines.
    test.skip(({ browserName }) => size.touch && browserName === 'firefox');

    for (const tool of [
      { name: 'PDF to Image', run: pdfToImage },
      { name: 'Resize Image batch', run: resizeBatch },
    ]) {
      test(`${tool.name}: cards fit the pane and stay readable`, async ({ page }) => {
        await tool.run(page);
        const m = await measure(page);
        expectFits(m, 3);
        // A finger needs a 44 px target; a mouse does not.
        if (size.touch) for (const h of m.buttonHeights) expect(h).toBeGreaterThanOrEqual(44);
      });
    }
  });
}
