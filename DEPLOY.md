# Deploying DocuKit

## 1. Cloudflare Pages Setup

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select your repo, configure:

| Setting | Value |
|---------|-------|
| Production branch | `main` |
| Framework preset | `Astro` |
| Build command | `npm run build` |
| Build output directory | `dist` |

3. Add environment variable: `NODE_VERSION` = `22` (must be >= 22.12 — Astro 6 refuses older; the repo also pins this in `.nvmrc`)
4. Click **Save and Deploy**

Site is live at `https://<project>.pages.dev`. Auto-deploys on push to `main`.

The `functions/` directory deploys as serverless API routes automatically alongside the static site.

## 2. Custom Domain

1. Pages project → **Custom domains** → **Set up a custom domain**
2. Enter `docukit.uk` → DNS auto-configures if domain is on Cloudflare
3. SSL provisioned automatically (~2 min)

## 3. KV Store (for View-Once feature)

Without this, view-once image uploads will fail.

```bash
npx wrangler login                                    # Auth with Cloudflare
npx wrangler kv namespace create "VIEW_ONCE_KV"        # Copy the id from output
```

Then bind it to your Pages project:

1. Pages project → **Settings** → **Bindings**
2. **Add binding** → KV namespace
3. Variable name: `VIEW_ONCE_KV`, select the namespace you created
4. Save → trigger a redeploy

Optionally set `ALLOWED_ORIGIN` = `https://docukit.uk` in **Settings** → **Environment variables** for strict CORS. If omitted, defaults to same-origin.

## 4. Verify

- [ ] Site loads, no console errors
- [ ] Response headers include `Cross-Origin-Embedder-Policy: require-corp`
- [ ] PDF tools work (client-side, no server needed)
- [ ] View-Once: upload image → get link → open in incognito → shows once → expired on refresh

## Troubleshooting

| Problem | Fix |
|---------|-----|
| View-Once upload error | KV not bound — do Step 3 |
| CORS error on view-once | Set `ALLOWED_ORIGIN` env var to your domain |
| SharedArrayBuffer unavailable | `public/_headers` must have COOP/COEP headers (already included) |
| Build fails on Node version | Set `NODE_VERSION=22` in Pages env vars. `package.json` declares `engines: >=22.12.0`; an older value fails with "Node.js v20 is not supported by Astro" |
| Stale PWA content | DevTools → Application → Storage → Clear site data |
| Bindings not working | Redeploy after adding bindings (they don't apply retroactively) |
