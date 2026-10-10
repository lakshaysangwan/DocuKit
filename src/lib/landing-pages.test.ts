import { describe, expect, it } from 'vitest';
import { LANDING_PAGES } from './landing-pages';
import { TOOLS, getToolBySlug } from './tools-registry';

/** Every user-visible string on a landing page. */
function copyOf(page: (typeof LANDING_PAGES)[number]): string[] {
  return [
    page.name, page.howToName, page.shortDescription, page.longDescription,
    page.pageTitle, page.metaDescription, page.h1,
    ...page.features,
    ...page.faqs.flatMap((f) => [f.q, f.a]),
    ...page.howToSteps.flatMap((s) => [s.title, s.description]),
  ];
}

describe('landing pages', () => {
  it('have unique slugs that do not collide with a real tool', () => {
    const slugs = LANDING_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter((s) => getToolBySlug(s))).toEqual([]);
  });

  it('have unique titles, descriptions and headings — across tools too', () => {
    for (const field of ['pageTitle', 'metaDescription', 'h1'] as const) {
      const values = [...TOOLS, ...LANDING_PAGES].map((p) => p[field]);
      const dupes = values.filter((v, i) => values.indexOf(v) !== i);
      expect(dupes, `duplicate ${field}`).toEqual([]);
    }
  });

  // The parity gate (tests/e2e/parity) accounts for every bullet a real tool
  // advertises. A landing page is the same tool under another name, so it may
  // only repeat those bullets — never add a promise the gate has not seen.
  it('only advertise feature bullets their base tool advertises', () => {
    const invented: string[] = [];
    for (const page of LANDING_PAGES) {
      const base = getToolBySlug(page.baseSlug)!;
      for (const feature of page.features) {
        if (!base.features.includes(feature)) invented.push(`${page.slug}: ${feature}`);
      }
    }
    expect(invented).toEqual([]);
  });

  it('only link to related tools that exist', () => {
    const broken = LANDING_PAGES.flatMap((p) =>
      p.relatedSlugs.filter((s) => !getToolBySlug(s)).map((s) => `${p.slug} -> ${s}`));
    expect(broken).toEqual([]);
  });

  it('never use the word "free" in visible copy', () => {
    const offenders = LANDING_PAGES.flatMap((p) =>
      copyOf(p).filter((text) => /\bfree\b/i.test(text)).map((text) => `${p.slug}: ${text}`));
    expect(offenders).toEqual([]);
  });

  it('keep titles and descriptions within search-result length', () => {
    const tooLong = LANDING_PAGES.flatMap((p) => [
      ...(p.pageTitle.length > 60 ? [`${p.slug} title (${p.pageTitle.length})`] : []),
      ...(p.metaDescription.length > 160 ? [`${p.slug} description (${p.metaDescription.length})`] : []),
    ]);
    expect(tooLong).toEqual([]);
  });
});
