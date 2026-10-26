import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { TOOLS } from '../../../src/lib/tools-registry';
import { MIGRATED } from './migrated';

/**
 * The workspace contract (docs/design/tool-workspace.md, sections 2.4, 2.7, 2.8).
 *
 * These are the rules that make "what do I click?" answerable at a glance, so
 * they are checked for every tool that has moved into the workspace:
 *
 *   • exactly one filled button on screen, in every state;
 *   • a prompt — one sentence saying what to do — in every state;
 *   • a disabled action always shows why;
 *   • the action and the download are the same box, and nothing else moves when
 *     one replaces the other;
 *   • focus moves to the download when it appears;
 *   • no serious accessibility violations with the workspace open.
 */

/** Any script, with or without a query string (Astro re-imports a failed island script with `?astro-retry=`). */
const ANY_SCRIPT = /\.js(\?.*)?$/;

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Snapshot {
  /** Visible buttons painted with one of the site's solid fills. */
  filled: string[];
  prompt: string;
  stage: Box | null;
  /** The button in the action slot: `tool-action`, or `download-button` once done. */
  slot: Box | null;
  phase: string | null;
}

type SnapshotWindow = Window & { __wsSnapshot?: () => Snapshot };

/**
 * Runs in the page: defines `window.__wsSnapshot`. It counts filled buttons by
 * what is actually painted — a background equal to one of the site's solid fill
 * colours — not by a marker attribute the component could set on itself.
 */
function installSnapshot() {
  (window as SnapshotWindow).__wsSnapshot = function snapshotWorkspace(): Snapshot {
  const root = document.querySelector('[data-testid="workspace"]');
  const box = (el: Element | null): Box | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  if (!root) return { filled: [], prompt: '', stage: null, slot: null, phase: null };

  const probe = document.createElement('span');
  document.body.appendChild(probe);
  const fills = ['--color-text-primary', '--color-primary', '--color-success'].map((name) => {
    probe.style.backgroundColor = `var(${name})`;
    return getComputedStyle(probe).backgroundColor;
  });
  probe.remove();

  const filled: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
    if (fills.includes(style.backgroundColor)) {
      filled.push(el.getAttribute('data-testid') ?? el.textContent?.trim() ?? el.tagName);
    }
  }
  return {
    filled,
    prompt: root.querySelector('[data-testid="step-prompt"]')?.textContent?.trim() ?? '',
    stage: box(root.querySelector('[data-testid="ws-stage"]')),
    slot: box(root.querySelector('[data-testid="tool-action"], [data-testid="download-button"]')),
    phase: root.querySelector('[data-testid="action-bar"]')?.getAttribute('data-phase') ?? null,
  };
  };
}

async function snapshot(page: Page): Promise<Snapshot> {
  await page.evaluate(installSnapshot);
  return page.evaluate(() => (window as SnapshotWindow).__wsSnapshot!());
}

function expectSameBox(actual: Box | null, expected: Box | null, what: string) {
  expect(actual, `${what} exists`).not.toBeNull();
  expect(expected, `${what} existed before`).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual![key] - expected![key]), `${what}.${key} moved by`).toBeLessThanOrEqual(1);
  }
}

async function seriousViolations(page: Page) {
  // Contrast is graded on what settles on screen, not a frame of a CSS
  // transition: the action button fades from its disabled 40% opacity to full
  // over 150 ms when it becomes available, and axe reads the computed opacity
  // mid-fade if it runs in that window (it did, on Linux WebKit in CI).
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) || a.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `[${v.impact}] ${v.id}: ${v.help} — e.g. ${v.nodes[0]?.target.join(' ')}`);
}

for (const tool of MIGRATED) {
  test.describe(`Workspace contract — ${tool.name}`, () => {
    test('before a file is added the page is the ordinary narrow column', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`/${tool.slug}`);
      await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible();
      await expect(page.getByTestId('workspace')).toHaveCount(0);
      // max-w-6xl: 72rem. The workspace must not have widened anything yet.
      const shell = (await page.locator('.tool-shell').boundingBox())!;
      expect(shell.width).toBeLessThanOrEqual(1152);
      expect(await page.evaluate(() => document.documentElement.dataset.ws)).toBeUndefined();
    });

    test('hydration does not move or resize the tool before a file is added', async ({ page }) => {
      // What the server sent, before any script has run… (the regex also
      // catches Astro's `?astro-retry=` re-import of a failed island script)
      await page.route(ANY_SCRIPT, (route) => route.abort());
      await page.goto(`/${tool.slug}`);
      const server = (await page.locator('.tool-shell').boundingBox())!;
      await page.unroute(ANY_SCRIPT);
      // …and the same page once the island is live.
      await page.goto(`/${tool.slug}`);
      await expect(page.locator('[data-testid="dropzone"][data-hydrated="true"]').first()).toBeVisible();
      const hydrated = (await page.locator('.tool-shell').boundingBox())!;
      expectSameBox(hydrated, server, 'tool column');
    });

    test('the frame fills the viewport under the header, at every desktop width', async ({ page }) => {
      for (const [width, height] of [[1920, 1080], [1280, 720], [1024, 768]] as const) {
        await page.setViewportSize({ width, height });
        await tool.enter(page);
        const frame = (await page.getByTestId('workspace').boundingBox())!;
        const action = (await page.getByTestId('action-bar').boundingBox())!;
        const stage = (await page.getByTestId('ws-stage').boundingBox())!;
        const controls = (await page.getByTestId('ws-controls').boundingBox())!;
        // Under the sticky header, and all of it on screen.
        expect(frame.y, `${width}: frame top`).toBeGreaterThanOrEqual(61);
        expect(frame.y, `${width}: frame top`).toBeLessThanOrEqual(80);
        expect(frame.y + frame.height, `${width}: frame bottom`).toBeLessThanOrEqual(height);
        expect(action.y + action.height, `${width}: action bar bottom`).toBeLessThanOrEqual(height);
        // Wider than the 72rem column where there is room for it.
        if (width > 1300) expect(frame.width, `${width}: frame width`).toBeGreaterThan(1152);
        // Document on the left, controls on the right, side by side.
        expect(stage.x + stage.width, `${width}: document is left of the controls`).toBeLessThanOrEqual(controls.x + 1);
        expect(stage.width, `${width}: the document has most of the width`).toBeGreaterThan(controls.width * 1.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      }
    });

    test('one filled button, a prompt and a reason for every disabled action — in every state', async ({ page }) => {
      await tool.enter(page);
      await expect(page.getByTestId('workspace-title')).toBeFocused();

      // Just entered. The action may not be available yet; if not, it says why.
      const entered = await snapshot(page);
      expect(entered.filled, 'filled buttons on entry').toHaveLength(1);
      expect(entered.prompt.length, 'prompt on entry').toBeGreaterThan(10);
      const action = page.getByTestId('tool-action');
      if (await action.isDisabled()) {
        const hint = page.getByTestId('action-hint');
        await expect(hint).toHaveAttribute('data-disabled-reason', 'true');
        expect(((await hint.textContent()) ?? '').trim().length, 'the disabled action says why').toBeGreaterThan(5);
        // And the button points at its reason for assistive tech.
        expect(await action.getAttribute('aria-describedby')).toBe(await hint.getAttribute('id'));
      }
      expect(await seriousViolations(page), 'axe on entry').toEqual([]);

      // Ready: the action can run.
      await tool.makeReady?.(page);
      await expect(action).toBeEnabled();
      const ready = await snapshot(page);
      expect(ready.filled, 'filled buttons when ready').toEqual(['tool-action']);
      expect(ready.prompt.length, 'prompt when ready').toBeGreaterThan(10);
      expect(ready.phase).toBe('ready');
      expectSameBox(ready.stage, entered.stage, 'stage (entered → ready)');
      expectSameBox(ready.slot, entered.slot, 'action slot (entered → ready)');
      expect(await seriousViolations(page), 'axe when ready').toEqual([]);

      // Running is over in a moment, so it is photographed from inside the page
      // the instant the action bar enters that state.
      await page.evaluate(() => {
        const w = window as SnapshotWindow & { __running?: unknown };
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="action-bar"][data-phase="running"]')) return;
          w.__running = {
            ...w.__wsSnapshot!(),
            overlay: !!document.querySelector('[data-testid="processing-overlay"]'),
            announce: document.querySelector('[data-testid="progress-announce"]')?.textContent ?? '',
          };
          observer.disconnect();
        });
        observer.observe(document.querySelector('[data-testid="workspace"]')!, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      });

      await action.click();
      await expect(page.getByTestId('download-button')).toBeVisible({ timeout: 45_000 });

      const running = await page.evaluate(
        () => (window as unknown as { __running?: Snapshot & { overlay: boolean; announce: string } }).__running,
      );
      expect(running, 'the running state was shown').toBeTruthy();
      expect(running!.filled, 'filled buttons while running').toEqual(['tool-action']);
      expect(running!.prompt.length, 'prompt while running').toBeGreaterThan(5);
      expect(running!.overlay, 'processing-overlay while running').toBe(true);
      expect(running!.announce, 'progress-announce while running').toMatch(/\d+% complete/);
      expectSameBox(running!.stage, ready.stage, 'stage (ready → running)');
      expectSameBox(running!.slot, ready.slot, 'action slot (ready → running)');

      // Done: the download is in the action's place, and has focus.
      await expect(page.getByTestId('download-button')).toBeFocused();
      const done = await snapshot(page);
      expect(done.filled, 'filled buttons when done').toEqual(['download-button']);
      expect(done.prompt.length, 'prompt when done').toBeGreaterThan(10);
      expect(done.phase).toBe('done');
      expectSameBox(done.stage, ready.stage, 'stage (ready → done)');
      expectSameBox(done.slot, ready.slot, 'download button vs action button');
      await expect(page.getByTestId('tool-action')).toHaveCount(0);
      await expect(page.getByTestId('result-summary')).not.toBeEmpty();
      await expect(page.getByTestId('edit-again')).toBeVisible();
      expect(await seriousViolations(page), 'axe when done').toEqual([]);

      // Make changes: back to the action, same box, result gone.
      await page.getByTestId('edit-again').click();
      await expect(action).toBeVisible();
      await expect(page.getByTestId('download-button')).toHaveCount(0);
      const again = await snapshot(page);
      expect(again.filled, 'filled buttons after Make changes').toEqual(['tool-action']);
      expectSameBox(again.slot, ready.slot, 'action slot (done → ready)');
      expectSameBox(again.stage, ready.stage, 'stage (done → ready)');
    });

    test('nothing about the workspace depends on hover', async ({ page }) => {
      await tool.enter(page);
      await tool.makeReady?.(page);
      // Park the pointer well away from the workspace, then look at what is on screen.
      await page.mouse.move(2, 2);
      const hidden = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="workspace"]')!;
        const out: string[] = [];
        for (const el of root.querySelectorAll<HTMLElement>('button')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue; // not rendered at this width
          const style = getComputedStyle(el);
          if (style.opacity === '0' || style.visibility === 'hidden') {
            out.push(el.getAttribute('data-testid') ?? el.textContent?.trim() ?? 'button');
          }
        }
        return out;
      });
      expect(hidden, 'buttons that only appear on hover').toEqual([]);
    });

    test('skip links jump to the options and to the document', async ({ page }) => {
      await tool.enter(page);
      await page.getByRole('link', { name: 'Skip to options' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('ws-controls')).toBeFocused();
      await page.getByRole('link', { name: 'Skip to document' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('ws-stage')).toBeFocused();
    });

  });
}

// Every tool now runs in the workspace, so there is no unmigrated tool left to
// check "not widened" against (each tool's narrow pre-upload column is checked
// above). What is checked instead: no tool can be added without joining the
// workspace's rules.
test('every tool in the registry is held to the workspace contract', () => {
  const missing = TOOLS.map((t) => t.slug).filter((slug) => !MIGRATED.some((m) => m.slug === slug));
  expect(missing, 'tools missing from tests/e2e/workspace/migrated.ts').toEqual([]);
});
