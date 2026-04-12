// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import AstroPWA from '@vite-pwa/astro';
import { viewOnceMockPlugin } from './src/lib/vite-view-once-mock.ts';

// https://astro.build/config
export default defineConfig({
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
        theme_color: '#1A56DB',
        background_color: '#0F172A',
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
      exclude: ['pdfjs-dist'],
    },
    worker: {
      format: 'es',
    },
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});
