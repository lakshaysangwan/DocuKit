import { expect, type Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { uploadFiles } from '../helpers/harness';
import { openSign, addTypedSignature } from '../helpers/sign';
import { openImages } from '../helpers/image-to-pdf';
import { openEdit, addObject } from '../helpers/edit-pdf';
import { openMerge } from '../helpers/merge-pdf';
import { openSplit } from '../helpers/split-pdf';
import { openCompress } from '../helpers/compress-pdf';
import { openWatermark } from '../helpers/watermark';
import { openPageNumbers } from '../helpers/page-numbers';
import { openCrop } from '../helpers/crop-pdf';
import { openOrganize } from '../helpers/organize-pages';
import { openPdfToImage } from '../helpers/pdf-to-image';
import { openRedact, openOptions as openRedactOptions } from '../helpers/redact-pdf';
import { encryptPdf, addPdfBuffer } from '../helpers/encrypted-pdf';
import { openDigitalSignature } from '../helpers/digital-signature';
import { openCompressImage } from '../helpers/compress-image';
import { openResize, openOptions as openResizeOptions } from '../helpers/resize-image';

/**
 * The tools that live in the shared workspace.
 *
 * `contract.spec.ts` and `mobile.spec.ts` run once per entry, so adding a line
 * here is what puts a newly migrated tool under the workspace's rules: one
 * filled button, a prompt at every step, a reason on every disabled action, one
 * action slot that does not move, focus handed to the download.
 *
 * The coordinator edits this list, as with the registry and coverage files.
 */
export interface MigratedTool {
  slug: string;
  name: string;
  /**
   * Add the file. When this resolves the workspace is open and its document is
   * drawn; the action may still be unavailable.
   */
  enter: (page: Page) => Promise<void>;
  /**
   * From a workspace just entered, do the least a visitor must do before the
   * action can run. Omit it for a tool whose action is available at once.
   */
  makeReady?: (page: Page) => Promise<void>;
}

export const MIGRATED: MigratedTool[] = [
  {
    slug: 'sign-pdf',
    name: 'Sign PDF',
    enter: (page) => openSign(page, FIXTURE.pdf3page),
    makeReady: (page) => addTypedSignature(page),
  },
  {
    // A "build a document" tool: several files in, one PDF out. Its document
    // pane is a grid of the output pages, and its action is available as soon
    // as the images have been read — so there is no `makeReady`.
    slug: 'image-to-pdf',
    name: 'Image to PDF',
    enter: (page) => openImages(page, [FIXTURE.jpg, FIXTURE.jpg2, FIXTURE.png]),
  },
  {
    // A place-on-page tool like Sign: the page large, a palette of things to
    // add in the controls pane. Saving needs at least one thing on a page.
    slug: 'edit-pdf',
    name: 'Edit PDF',
    enter: (page) => openEdit(page, FIXTURE.pdf3page),
    makeReady: async (page) => {
      await addObject(page, 'text');
    },
  },
  {
    // "Build a document" like Image to PDF, from PDFs: the document pane is every
    // page of the merged PDF in output order; the files are rows in the controls.
    // Two files are enough to merge, so there is no `makeReady`.
    slug: 'merge-pdf',
    name: 'Merge PDF',
    enter: (page) => openMerge(page, [FIXTURE.pdf3page, FIXTURE.pdf5page], 8),
  },
  {
    // A pick-pages tool: the document pane is every page, marked with what will
    // become of it. It opens in Extract Pages, which waits for pages to be
    // chosen, so `makeReady` picks two by clicking them.
    slug: 'split-pdf',
    name: 'Split PDF',
    enter: (page) => openSplit(page, FIXTURE.pdf3page, 3),
    makeReady: async (page) => {
      await page.getByTestId('page-select-0').click();
      await page.getByTestId('page-select-2').click();
    },
  },
  {
    // A one-page-large tool: the stage compares a page of the original with the
    // same page of the result. Medium is chosen on entry, so the action is
    // available at once and there is no `makeReady`.
    slug: 'compress-pdf',
    name: 'Compress PDF',
    enter: (page) => openCompress(page, FIXTURE.pdf3page),
  },
  {
    // A place-on-page tool whose stage is any page with the watermark drawn on
    // it from the layout the worker writes with. "CONFIDENTIAL" is set on
    // entry, so the action is available at once and there is no `makeReady`.
    slug: 'watermark-pdf',
    name: 'Watermark PDF',
    enter: (page) => openWatermark(page, FIXTURE.pdf3page),
  },
  {
    // A place-on-page tool like Watermark: any page large with that page's own
    // number drawn on it from the layout the worker writes with. Every page is
    // numbered on entry, so the action is available at once and there is no
    // `makeReady`.
    slug: 'add-page-numbers',
    name: 'Add Page Numbers',
    enter: (page) => openPageNumbers(page, FIXTURE.pdf3page),
  },
  {
    // A one-page-large tool with a box on the page: any page shown with the
    // crop box over it. Nothing is cropped on entry, so the action waits (and
    // says why) until an edge moves; `makeReady` nudges the top edge with the
    // keyboard, which works the same on a phone.
    slug: 'crop-pdf',
    name: 'Crop PDF',
    enter: (page) => openCrop(page, FIXTURE.pdf3page),
    makeReady: async (page) => {
      await page.getByTestId('overlay-handle-top').focus();
      await page.keyboard.press('Shift+ArrowDown');
      // A key press enables the action at once; let its 150ms fade-in finish so
      // what is checked next is the button as it settles, not mid-fade.
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
  {
    // An arrange-pages tool: the document pane is a sortable grid of every page
    // with its own rotate / duplicate / delete buttons. Saving the pages as they
    // are is allowed, so the action is available at once and there is no
    // `makeReady`.
    slug: 'rearrange-pdf-pages',
    name: 'Rearrange PDF Pages',
    enter: (page) => openOrganize(page, FIXTURE.pdf3page, 3),
  },
  {
    // A pick-pages tool like Split: the document pane is every page, those left
    // out marked "Not exported", and each page's magnifier shows it as the image
    // it will be saved as. Every page is chosen on entry, so the action is
    // available at once and there is no `makeReady`.
    slug: 'pdf-to-image',
    name: 'PDF to Image',
    enter: (page) => openPdfToImage(page, FIXTURE.pdf3page, 3),
  },
  {
    // A place-on-page tool: one page large, a drag on it draws a mark. Nothing
    // is marked on entry and the removal must be confirmed, so `makeReady`
    // adds a mark with the button (as a keyboard or a finger can) and ticks the
    // confirmation.
    slug: 'redact-pdf',
    name: 'Redact PDF',
    enter: (page) => openRedact(page, FIXTURE.pdf3page),
    makeReady: async (page) => {
      await page.getByTestId('add-mark').click();
      await expect(page.getByTestId('overlay-item')).toHaveCount(1);
      await openRedactOptions(page);
      await page.getByTestId('confirm-redaction').check();
      // Let the action's fade-in finish, so what is checked next is the button as it settles.
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
  {
    // A whole-file transform: the page large so the visitor confirms the file.
    // The action waits for a password (and says so); `makeReady` types one in
    // both fields of the controls pane, opening Options on a phone first.
    slug: 'protect-pdf',
    name: 'Protect PDF',
    enter: async (page) => {
      await page.goto('/protect-pdf');
      await uploadFiles(page, FIXTURE.pdf3page);
      await expect(page.getByTestId('workspace')).toBeVisible();
      await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
    },
    makeReady: async (page) => {
      await openRedactOptions(page);
      await page.getByTestId('password').fill('contract-pw-2026');
      await page.getByTestId('confirm-password').fill('contract-pw-2026');
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
  {
    // A locked file: the stage is a locked placeholder and the action waits for
    // the password. `makeReady` types it in the controls pane and presses
    // Enter, and the pages appear.
    slug: 'unlock-pdf',
    name: 'Unlock PDF',
    enter: async (page) => {
      await addPdfBuffer(page, 'unlock-pdf', await encryptPdf(FIXTURE.pdf3page, { user: 'contract-pw', owner: 'contract-owner' }));
      await expect(page.getByTestId('workspace')).toBeVisible();
      await expect(page.getByTestId('locked-stage')).toBeVisible({ timeout: 30_000 });
    },
    makeReady: async (page) => {
      await openRedactOptions(page);
      await page.getByTestId('unlock-password').fill('contract-pw');
      await page.getByTestId('unlock-password').press('Enter');
      await expect(page.locator('[data-testid="page-canvas"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
  {
    // A whole-file transform with a box on the page: the page large with the
    // visible signature box on it where it will be written. The action waits
    // for a certificate (and says so); `makeReady` types a name for the
    // self-signed one, opening Options on a phone first.
    slug: 'digital-signature-pdf',
    name: 'Digital Signature PDF',
    enter: (page) => openDigitalSignature(page, FIXTURE.pdf3page),
    makeReady: async (page) => {
      await openRedactOptions(page);
      await page.getByPlaceholder('John Doe').fill('Ada Lovelace');
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
  {
    // The first image tool: the image large on a checkerboard, Original vs
    // Compressed in the compare view. WebP at quality 75 is chosen on entry, so
    // the action is available once the image has been read — no `makeReady`.
    slug: 'compress-image',
    name: 'Compress Image',
    enter: (page) => openCompressImage(page, FIXTURE.jpg),
  },
  {
    // An image tool whose stage is the output frame: the chosen size at its
    // real proportions with the image placed as the fit mode will place it. It
    // opens at the image's own size, so the action waits (and says why) until
    // a new size is typed; `makeReady` types a width, opening Options on a
    // phone first.
    slug: 'resize-image',
    name: 'Resize Image',
    enter: (page) => openResize(page, FIXTURE.jpg),
    makeReady: async (page) => {
      await openResizeOptions(page);
      await page.getByLabel('Width (px)').fill('600');
      const action = page.getByTestId('tool-action');
      await expect(action).toBeEnabled();
      await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    },
  },
];
