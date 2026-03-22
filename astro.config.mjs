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
        // Cache-first for hashed assets (JS/CSS/WASM/fonts/images)
        globPatterns: ['**/*.{js,css,wasm,woff2,ico,svg,png}'],
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
        ],
      },
      manifest: {
        name: 'Docukit',
        short_name: 'Docukit',
        description: 'Free PDF & Image Tools — 100% browser-based, no uploads',
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
