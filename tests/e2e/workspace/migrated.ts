import type { Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { openSign, addTypedSignature } from '../helpers/sign';
import { openImages } from '../helpers/image-to-pdf';
import { openEdit, addObject } from '../helpers/edit-pdf';
import { openMerge } from '../helpers/merge-pdf';
import { openSplit } from '../helpers/split-pdf';
import { openCompress } from '../helpers/compress-pdf';
import { openWatermark } from '../helpers/watermark';
import { openPageNumbers } from '../helpers/page-numbers';
import { openCrop } from '../helpers/crop-pdf';

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
    },
  },
];
