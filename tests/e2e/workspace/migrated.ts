import type { Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { openSign, addTypedSignature } from '../helpers/sign';
import { openImages } from '../helpers/image-to-pdf';
import { openEdit, addObject } from '../helpers/edit-pdf';
import { openMerge } from '../helpers/merge-pdf';
import { openSplit } from '../helpers/split-pdf';

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
];
