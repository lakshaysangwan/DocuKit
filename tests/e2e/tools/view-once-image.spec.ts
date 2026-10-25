import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FIXTURE } from '../fixtures/generate';
import { PageDiagnostics, expectDownload, expectImageRendered } from '../helpers/harness';
import {
  createLink,
  decryptUpload,
  linkSecrets,
  openViewOnce,
  plantLink,
  routeViewPages,
  stubViewOnceApi,
} from '../helpers/view-once';

/**
 * View-Once is the one tool that talks to a server: it encrypts in the browser
 * and POSTs the ciphertext to a Pages Function (/api/view-once). The suite runs
 * against a static build and must never call the production API, so the API is
 * stubbed in the browser context (helpers/view-once.ts) and every request it
 * receives is recorded. That is what these tests read: the exact bytes and
 * headers that would reach the server, decrypted with the key from the link.
 * The function itself is unit-tested in functions/api/view-once.
 */
test.describe('View-Once Image', () => {
  test('page loads with correct H1 and dropzone', async ({ page }) => {
    const diag = new PageDiagnostics(page);
    await page.goto('/view-once-image');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Disappears After One View');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(diag.allErrors, `errors: ${diag.allErrors.join(' | ')}`).toEqual([]);
  });

  test('the server receives only ciphertext and the expiry; the key is only after the #', async ({ page, baseURL }) => {
    const api = await openViewOnce(page, FIXTURE.jpg);
    await expect(page.getByTestId('stage-status')).toContainText('JPEG, 1200 × 800 px');
    await expect(page.getByTestId('upload-explainer')).toContainText('Not sent: the key');

    // Every request the page makes from here on, wherever it goes.
    const all: { url: string; headers: Record<string, string>; body: Buffer | null }[] = [];
    page.on('request', async (req) => all.push({ url: req.url(), headers: req.headers(), body: req.postDataBuffer() }));

    await page.getByTestId('ttl-3600').click();
    await expect(page.getByTestId('ttl-3600')).toHaveAttribute('aria-pressed', 'true');
    const link = await createLink(page);

    const posts = api.seen.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    const upload = posts[0];
    expect(new URL(upload.url).pathname).toBe('/api/view-once');
    expect(upload.headers['x-ttl']).toBe('3600');
    expect(upload.headers['content-type']).toBe('application/octet-stream');

    const original = await readFile(FIXTURE.jpg);
    const body = upload.body!;
    // Payload = 2-byte length + "image/jpeg" + the image, plus AES-GCM's 16-byte tag.
    expect(body.length).toBe(original.length + 2 + 'image/jpeg'.length + 16);
    // No 32-byte run of the image anywhere in what was sent.
    for (let at = 0; at + 32 <= original.length; at += 1531) {
      expect(body.includes(original.subarray(at, at + 32)), `image bytes at ${at} in the upload`).toBe(false);
    }
    expect(body.includes(Buffer.from('image/jpeg')), 'the type is encrypted too').toBe(false);

    // The link: this origin, /view/<the id the server gave>, key and IV after the #.
    const { id, key, iv, fragment } = linkSecrets(link);
    expect(link.startsWith(`${new URL(baseURL!).origin}/view/${id}#`)).toBe(true);
    expect(api.store.has(id)).toBe(true);
    expect(key).toHaveLength(32);
    expect(iv).toHaveLength(12);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}$/);

    // The key went nowhere: not in any URL, header or body the page sent.
    const secrets = [fragment.split('.')[0], key.toString('base64'), key.toString('hex')];
    for (const r of all) {
      const text = `${r.url}\n${JSON.stringify(r.headers)}`;
      for (const s of secrets) expect(text.includes(s), `key in ${r.url}`).toBe(false);
      if (r.body) {
        expect(r.body.includes(key), `raw key in the body of ${r.url}`).toBe(false);
        for (const s of secrets) expect(r.body.includes(Buffer.from(s)), `key text in the body of ${r.url}`).toBe(false);
      }
    }

    // And the upload is exactly the image under that key.
    const opened = await decryptUpload(body, link);
    expect(opened.type).toBe('image/jpeg');
    expect(opened.image.equals(original), 'the upload decrypts to the image').toBe(true);

    // The result pane says what the link does.
    await expect(page.getByTestId('fact-once')).toContainText('Opens once');
    await expect(page.getByTestId('fact-expiry')).toContainText('1 hour');
    await expect(page.getByTestId('fact-uploaded')).toContainText('Not uploaded: the key');
    await expect(page.getByTestId('result-summary')).toContainText('expires in 1 hour');
  });

  test('each expiry is what is sent', async ({ page }) => {
    const api = await openViewOnce(page, FIXTURE.png);
    for (const seconds of [21600, 86400, 604800]) {
      await page.getByTestId(`ttl-${seconds}`).click();
      await createLink(page);
      expect(api.seen.filter((r) => r.method === 'POST').at(-1)!.headers['x-ttl']).toBe(String(seconds));
      await page.getByTestId('edit-again').click();
    }
  });

  test('Copy link puts the link on the clipboard', async ({ page, browserName, context }) => {
    test.skip(browserName !== 'chromium', 'reading the clipboard back needs the Chromium permission');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openViewOnce(page, FIXTURE.jpg);
    const link = await createLink(page);
    await expect(page.getByTestId('download-button')).toBeFocused();
    await page.getByTestId('download-button').click();
    await expect(page.getByTestId('download-button')).toContainText('Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  });

  test('the link opens once: nothing is fetched until Open image, then the image, then it is gone', async ({
    page,
    context,
    baseURL,
  }) => {
    const api = await openViewOnce(page, FIXTURE.jpg);
    const link = await createLink(page);
    await routeViewPages(context, baseURL!);

    const recipient = await context.newPage();
    await recipient.goto(link);
    await expect(recipient.getByTestId('view-once-ready')).toBeVisible();
    // A preview or an accidental load must not use the link up.
    await recipient.waitForTimeout(500);
    expect(api.seen.filter((r) => r.method === 'GET'), 'no fetch before Open image').toHaveLength(0);

    await recipient.getByTestId('view-once-open').click();
    await expectImageRendered(recipient.getByTestId('view-once-image'));
    const gets = api.seen.filter((r) => r.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].url).not.toContain('#');
    expect(api.store.size, 'the stub deleted it on the first read, as the function does').toBe(0);

    const saved = await expectDownload(recipient, () => recipient.getByTestId('view-once-save').click());
    expect(saved.name).toBe('image.jpg');
    expect(saved.bytes.equals(await readFile(FIXTURE.jpg)), 'the recipient gets the exact image').toBe(true);

    // Opening the link again: gone.
    const again = await context.newPage();
    await again.goto(link);
    await again.getByTestId('view-once-open').click();
    await expect(again.getByTestId('view-once-error')).toContainText('no longer available');
  });

  test('a link with a damaged key, or none, does not open', async ({ page, context, baseURL }) => {
    const api = await openViewOnce(page, FIXTURE.jpg);
    const link = await createLink(page);
    await routeViewPages(context, baseURL!);

    const noKey = await context.newPage();
    await noKey.goto(link.split('#')[0]);
    await expect(noKey.getByTestId('view-once-error')).toContainText('not complete');
    expect(api.seen.filter((r) => r.method === 'GET'), 'an incomplete link fetches nothing').toHaveLength(0);

    const { fragment } = linkSecrets(link);
    const wrong = `${fragment[0] === 'A' ? 'B' : 'A'}${fragment.slice(1)}`;
    const damaged = await context.newPage();
    await damaged.goto(`${link.split('#')[0]}#${wrong}`);
    await damaged.getByTestId('view-once-open').click();
    await expect(damaged.getByTestId('view-once-error')).toContainText('could not be decrypted');
  });

  test('a link whose contents claim to be a web page is refused, not shown', async ({ page, context, baseURL }) => {
    const api = await stubViewOnceApi(context);
    await routeViewPages(context, baseURL!);
    const origin = new URL(baseURL!).origin;
    const link = await plantLink(api, origin, 'text/html', Buffer.from('<script>window.__pwned = 1</script>'));
    await page.goto(link);
    await page.getByTestId('view-once-open').click();
    await expect(page.getByTestId('view-once-error')).toContainText('does not hold an image');
    await expect(page.getByTestId('view-once-image')).toHaveCount(0);
    await expect(page.getByTestId('view-once-save')).toHaveCount(0);
  });

  test('a server error is said in the action slot and the action can be tried again', async ({ page }) => {
    const api = await openViewOnce(page, FIXTURE.jpg);
    api.failNextPost(503);
    await page.getByTestId('tool-action').click();
    await expect(page.getByTestId('action-error')).toContainText('error 503');
    await expect(page.getByTestId('step-prompt')).toContainText('could not be made');
    await createLink(page);
    await expect(page.getByTestId('share-link')).toHaveValue(/\/view\/[0-9a-f-]{36}#/);
  });
});
