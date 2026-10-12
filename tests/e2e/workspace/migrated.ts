import type { Page } from '@playwright/test';
import { FIXTURE } from '../fixtures/generate';
import { openSign, addTypedSignature } from '../helpers/sign';

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
];
