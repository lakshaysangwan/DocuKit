/**
 * Cloudflare Pages Function — View-Once Recipient Page
 *
 * Serves the static /view/index.html for any /view/:id path.
 * The React island inside the page reads the UUID from window.location.pathname
 * and the decryption key from the URL fragment.
 */
export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  url.pathname = '/view/index.html';
  return (context.env as { ASSETS: { fetch: typeof fetch } }).ASSETS.fetch(
    new Request(url.toString(), context.request),
  );
};
