/**
 * Cloudflare Pages Function — View-Once Recipient Page
 *
 * Catches /view/:id and serves the static /view/index.html.
 * The React island reads the UUID from window.location.pathname
 * and the decryption key from the URL fragment.
 */
export const onRequest: PagesFunction = async (context) => {
  const segments = (context.params.path as string[]) || [];

  // /view/ or /view/index.html → let Cloudflare serve the static asset directly
  if (segments.length === 0 || segments[0] === 'index.html') {
    return context.next();
  }

  // /view/:id → serve the static view page from the asset bucket
  const url = new URL(context.request.url);
  url.pathname = '/view/index.html';
  return (context.env as { ASSETS: { fetch: typeof fetch } }).ASSETS.fetch(
    new Request(url.toString()),
  );
};
