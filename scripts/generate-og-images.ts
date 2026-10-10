/**
 * Build-time OG image generator.
 * Generates a 1200×630 PNG for each tool page using satori (SVG) + sharp (PNG).
 *
 * Run:  npx tsx scripts/generate-og-images.ts
 */
import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOLS } from '../src/lib/tools-registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'og');
// satori reads TTF/OTF/WOFF only — not WOFF2, and not variable fonts — so the
// site's own public/fonts/inter-variable.woff2 can't be used here. These static
// cuts come from the @fontsource/inter devDependency.
const FONT_DIR = join(__dirname, '..', 'node_modules', '@fontsource', 'inter', 'files');
const FONT_WEIGHTS = [400, 600, 700, 800] as const;
const fonts = FONT_WEIGHTS.map((weight) => ({
  name: 'Inter',
  data: readFileSync(join(FONT_DIR, `inter-latin-${weight}-normal.woff`)),
  weight,
  style: 'normal' as const,
}));

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const CATEGORY_COLORS: Record<string, string> = {
  pdf: '#1A56DB',
  image: '#7C3AED',
};

async function generateOgImage(slug: string, name: string, description: string, category: string): Promise<void> {
  const accent = CATEGORY_COLORS[category] ?? '#1A56DB';
  const categoryLabel = category === 'pdf' ? 'PDF Tools' : 'Image Tools';

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '1200px',
          height: '630px',
          background: '#0F172A',
          padding: '60px',
          fontFamily: 'Inter',
        },
        children: [
          // Top: category badge
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      background: accent,
                      color: '#fff',
                      fontSize: '14px',
                      fontWeight: 600,
                      padding: '6px 14px',
                      borderRadius: '100px',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                    },
                    children: categoryLabel,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { color: '#475569', fontSize: '14px' },
                    children: 'No Uploads · 100% Browser-Based',
                  },
                },
              ],
            },
          },
          // Middle: tool name + description
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: '16px' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '64px',
                      fontWeight: 700,
                      color: '#F1F5F9',
                      lineHeight: 1.1,
                      letterSpacing: '-0.02em',
                    },
                    children: name,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '24px',
                      color: '#94A3B8',
                      lineHeight: 1.4,
                      maxWidth: '800px',
                    },
                    children: description,
                  },
                },
              ],
            },
          },
          // Bottom: Docukit branding
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '20px',
                      fontWeight: 700,
                      color: '#F1F5F9',
                    },
                    children: 'Docukit',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { fontSize: '16px', color: '#475569' },
                    children: 'docukit.uk',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts,
    }
  );

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const outPath = join(OUT_DIR, `${slug}.png`);
  writeFileSync(outPath, pngBuffer);
  console.log(`✓  ${slug}.png`);
}

// Also generate default OG image
async function generateDefault(): Promise<void> {
  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1200px',
          height: '630px',
          background: '#0F172A',
          gap: '24px',
          fontFamily: 'Inter',
        },
        children: [
          {
            type: 'div',
            props: {
              style: { fontSize: '80px', fontWeight: 800, color: '#F1F5F9', letterSpacing: '-0.03em' },
              children: 'Docukit',
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: '28px', color: '#94A3B8', textAlign: 'center', maxWidth: '800px' },
              children: 'PDF & Image Tools — 100% Browser-Based. No Uploads. No Sign-Up.',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '16px',
                color: '#475569',
                marginTop: '16px',
              },
              children: 'docukit.uk',
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts,
    }
  );

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(join(__dirname, '..', 'public', 'og-default.png'), pngBuffer);
  console.log('✓  og-default.png');
}

(async () => {
  console.log(`Generating OG images for ${TOOLS.length} tools…`);
  for (const tool of TOOLS) {
    await generateOgImage(tool.slug, tool.name, tool.shortDescription, tool.category);
  }
  await generateDefault();
  console.log('\nDone.');
})();
