# Docukit

**Free PDF & Image Tools — 100% in your browser.**

[![CI](https://github.com/lakshaysangwan/DocuKit/actions/workflows/ci.yml/badge.svg)](https://github.com/lakshaysangwan/DocuKit/actions/workflows/ci.yml)
[![Website](https://img.shields.io/badge/website-docukit.uk-blue)](https://docukit.uk)

Docukit processes every file entirely client-side using WebAssembly and the Canvas API. No uploads, no server processing, no accounts, no usage limits. Your files never leave your browser.

## Tools

| PDF Tools | Image Tools |
|-----------|-------------|
| [Merge PDF](https://docukit.uk/merge-pdf) — Combine multiple PDFs | [Compress Image](https://docukit.uk/compress-image) — Reduce file size |
| [Split PDF](https://docukit.uk/split-pdf) — Extract pages | [Resize Image](https://docukit.uk/resize-image) — Resize to exact dimensions |
| [Compress PDF](https://docukit.uk/compress-pdf) — Reduce file size | [Convert Image](https://docukit.uk/convert-image) — JPEG, PNG, WebP |
| [Edit PDF](https://docukit.uk/edit-pdf) — Annotate and draw | [Lock Image](https://docukit.uk/lock-image) — Encrypt with password |
| [Sign PDF](https://docukit.uk/sign-pdf) — Add visual signature | [View-Once Image](https://docukit.uk/view-once-image) — Self-destructing share |
| [Digital Signature](https://docukit.uk/digital-signature-pdf) — PKCS#7 signing | |
| [Protect PDF](https://docukit.uk/protect-pdf) — Password protect | |
| [Unlock PDF](https://docukit.uk/unlock-pdf) — Remove password | |
| [Watermark PDF](https://docukit.uk/watermark-pdf) — Text/image watermarks | |
| [Redact PDF](https://docukit.uk/redact-pdf) — Permanent content removal | |
| [Rearrange Pages](https://docukit.uk/rearrange-pdf-pages) — Reorder, rotate, delete | |
| [Add Page Numbers](https://docukit.uk/add-page-numbers) — Number your pages | |
| [Crop PDF](https://docukit.uk/crop-pdf) — Crop or trim pages | |
| [PDF to Image](https://docukit.uk/pdf-to-image) — Export pages as images | |
| [Image to PDF](https://docukit.uk/image-to-pdf) — Convert images to PDF | |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Astro 6](https://astro.build) + [React 19](https://react.dev) islands |
| Language | TypeScript 5.9 |
| Styling | Tailwind CSS 4 |
| PDF | [pdf-lib](https://pdf-lib.js.org), [PDF.js](https://mozilla.github.io/pdf.js/), [QPDF WASM](https://github.com/nicbarker/qpdf-wasm) |
| Image | [@jsquash](https://github.com/nicbarker/nicbarker.github.io) (JPEG, PNG, WebP WASM codecs) |
| Crypto | [node-forge](https://github.com/nicbarker/nicbarker.github.io) (X.509/PKCS), Web Crypto API (AES-256-GCM) |
| Hosting | [Cloudflare Pages](https://pages.cloudflare.com) + Pages Functions |
| PWA | [@vite-pwa/astro](https://vite-pwa-org.netlify.app/frameworks/astro) |

## Getting Started

```bash
npm install
npm run dev        # http://localhost:4321
```

Requires Node.js >= 22.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |

## Deployment

Deployed on Cloudflare Pages with auto-deploy on push to `main`. See [DEPLOY.md](DEPLOY.md) for setup instructions including KV store configuration for the view-once feature.

## Privacy

All file processing happens in the browser. No files are uploaded to any server. No cookies, no tracking, no analytics. The only server-side component is the view-once feature which stores encrypted blobs in Cloudflare KV — the encryption key never leaves the client.

## License

[MIT](LICENSE)
