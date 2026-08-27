// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import AstroPWA from '@vite-pwa/astro';
import { viewOnceMockPlugin } from './src/lib/vite-view-once-mock.ts';

// https://astro.build/config
export default defineConfig({
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  integrations: [
    react(),
    sitemap(),
    AstroPWA({
      registerType: 'autoUpdate',
      workbox: {
        // Only precache the shell (CSS, fonts, icons) — not tool-specific JS/WASM
        globPatterns: ['**/*.{css,woff2,ico,svg}'],
        runtimeCaching: [
          {
            // Stale-while-revalidate for HTML pages (10 min)
            urlPattern: /\.html$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'pages-cache',
              expiration: { maxAgeSeconds: 600 },
            },
          },
          {
            // Cache-first for hashed JS chunks (cache on first use)
            urlPattern: /\/_astro\/.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'js-cache',
              expiration: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
          {
            // Cache-first for WASM and worker files
            urlPattern: /\.(wasm|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
      manifest: {
        name: 'Docukit',
        short_name: 'Docukit',
        description: 'Private PDF & Image Tools — 100% browser-based, no uploads',
        theme_color: '#4F46E5',
        background_color: '#0A0A0A',
        display: 'standalone',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  output: 'static',
  site: 'https://docukit.uk',
  vite: {
    plugins: [tailwindcss(), viewOnceMockPlugin()],
    optimizeDeps: {
      // These ship their own WASM and must not be pre-bundled by esbuild.
      exclude: ['pdfjs-dist', 'mupdf', '@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/avif', 'heic-to'],
      // Crawl island + worker sources at server boot so heavy deps that are only
      // imported at operation time inside Web Workers (e.g. qpdf-wasm in
      // pdf-worker) are pre-bundled ONCE up front. Otherwise Vite discovers them
      // mid-operation and issues a "504 Outdated Optimize Dep" full-page reload
      // that wipes in-progress state. (Dev-only; production uses Rollup.)
      entries: ['src/**/*.{astro,ts,tsx}'],
    },
    worker: {
      format: 'es',
    },
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // WebKit refuses to load same-origin *workers* under require-corp unless the
      // response also carries an explicit CORP header, so pdf.js falls back to a
      // broken "fake worker" without it. Harmless on Chromium/Gecko.
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
});
