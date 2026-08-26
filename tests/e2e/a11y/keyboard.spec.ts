import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { addFilesAndWait } from '../helpers/harness';

/**
 * P4.3 — keyboard operability + screen-reader narration for the drag-and-drop
 * file list. dnd-kit's KeyboardSensor is wired, and FileList supplies
 * announcements that reference the real file name + position. This proves a
 * sighted-keyboard / screen-reader user can reorder files without a pointer.
 */

const cardNames = (page: Page) =>
  page.locator('[data-testid="file-card"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-filename'))
  );

test.describe('P4.3 — keyboard drag-and-drop reorder', () => {
  test('reorders files with the keyboard and announces the move', async ({ page }) => {
    await page.goto('/image-to-pdf');
    await addFilesAndWait(page, [FIXTURE.jpg, FIXTURE.png], 2);

    expect(await cardNames(page)).toEqual(['photo.jpg', 'graphic.png']);

    // Pick up the first card by its named drag handle, move right, drop. Gate
    // each keystroke on its announcement (dnd-kit's visually-hidden live region,
    // so assert attached not visible) — this both proves screen-reader narration
    // and lets each key settle before the next.
    const handle = page.getByRole('button', { name: 'Reorder photo.jpg' });
    await handle.focus();

    await page.keyboard.press('Space');
    await expect(page.getByText(/photo\.jpg moved to position 1 of 2/)).toBeAttached();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/photo\.jpg moved to position 2 of 2/)).toBeAttached();

    await page.keyboard.press('Space');
    await expect(page.getByText(/photo\.jpg dropped at position 2 of 2/)).toBeAttached();

    await expect.poll(() => cardNames(page)).toEqual(['graphic.png', 'photo.jpg']);
  });
});
