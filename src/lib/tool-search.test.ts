import { describe, expect, it } from 'vitest';
import { LANDING_PAGES } from './landing-pages';
import { TOOLS } from './tools-registry';
import {
  SUGGESTED_QUERIES, buildSearchIndex, createSearch, entryHref, parseSearchIndex, serializeSearchIndex,
  tokenize,
} from './tool-search';

// The real registries, not a fixture: what matters is that the pages the site
// actually has can be found by the words people actually type.
const PAGES = [...TOOLS, ...LANDING_PAGES];
const index = buildSearchIndex(PAGES);
const search = createSearch(index);
const slugs = (query: string) => search(query).map((entry) => entry.slug);

describe('search index', () => {
  it('has one entry for every tool and every task page, and nothing else', () => {
    expect(index.map((e) => e.slug)).toEqual(PAGES.map((p) => p.slug));
  });

  it('carries the name and description shown in the results, unchanged', () => {
    for (const page of PAGES) {
      const entry = index.find((e) => e.slug === page.slug)!;
      expect(entry.name).toBe(page.name);
      expect(entry.description).toBe(page.shortDescription);
      expect(entry.category).toBe(page.category);
    }
  });

  it('links with the trailing slash every page on the site is served at', () => {
    expect(entryHref({ slug: 'merge-pdf' })).toBe('/merge-pdf/');
    for (const entry of index) expect(entryHref(entry)).toMatch(/^\/[a-z0-9-]+\/$/);
  });
});

describe('serialized index', () => {
  it('survives the trip to the browser unchanged', () => {
    expect(parseSearchIndex(serializeSearchIndex(index))).toEqual(index);
    expect(parseSearchIndex(serializeSearchIndex([]))).toEqual([]);
  });

  it('refuses a field that would break the line format', () => {
    const broken = { ...index[0], name: 'Merge\tPDF' };
    expect(() => serializeSearchIndex([broken])).toThrow(/merge-pdf\.name/);
  });
});

describe('tokenize', () => {
  it('ignores case, punctuation and accents', () => {
    expect(tokenize('  View-Once   IMAGE! ')).toEqual(['view', 'once', 'image']);
    expect(tokenize('café')).toEqual(['cafe']);
  });

  it('reads a size the same however it is spaced', () => {
    expect(tokenize('100KB')).toEqual(['100', 'kb']);
    expect(tokenize('100 kb')).toEqual(['100', 'kb']);
    expect(tokenize('1mb')).toEqual(['1', 'mb']);
  });

  it('drops plurals but leaves words that merely end in s', () => {
    expect(tokenize('PDFs pages images')).toEqual(['pdf', 'page', 'image']);
    expect(tokenize('compress')).toEqual(['compress']);
  });
});

describe('search', () => {
  it('returns nothing for an empty or unsearchable query', () => {
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(search('!?')).toEqual([]);
  });

  it('returns nothing when no page mentions the word', () => {
    expect(search('xyzzy')).toEqual([]);
    expect(search('merge xyzzy')).toEqual([]);
  });

  it('puts a page first when its exact name is typed — every tool and task page', () => {
    for (const page of PAGES) {
      expect(slugs(page.name)[0], `"${page.name}"`).toBe(page.slug);
      expect(slugs(page.name.toUpperCase())[0], `"${page.name.toUpperCase()}"`).toBe(page.slug);
    }
  });

  // No "no results" flash on the way to a real name: every keystroke of every
  // page name keeps that page in the list.
  it('keeps a page in the results at every keystroke of its name', () => {
    const lost: string[] = [];
    for (const page of PAGES) {
      for (let length = 1; length <= page.name.length; length++) {
        const typed = page.name.slice(0, length);
        if (typed.trim() === '') continue;
        if (!slugs(typed).includes(page.slug)) lost.push(`${page.slug} at "${typed}"`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('finds a tool by a word from its description', () => {
    expect(slugs('combine')).toContain('merge-pdf');
    expect(slugs('password')).toEqual(expect.arrayContaining(['protect-pdf', 'unlock-pdf', 'lock-image']));
    expect(slugs('rotate')).toEqual(expect.arrayContaining(['rotate-pdf', 'rearrange-pdf-pages']));
  });

  it('finds "pdf to jpg" as the task page first, then the tool behind it', () => {
    const found = slugs('pdf to jpg');
    expect(found[0]).toBe('pdf-to-jpg');
    expect(found[1]).toBe('pdf-to-image');
  });

  it('respects word order between formats', () => {
    expect(slugs('jpg to pdf')[0]).toBe('jpg-to-pdf');
    expect(slugs('pdf to jpg')[0]).toBe('pdf-to-jpg');
    expect(slugs('png to jpg')[0]).toBe('png-to-jpg');
    expect(slugs('jpg to png')[0]).toBe('jpg-to-png');
  });

  it('treats jpeg and jpg as the same word', () => {
    expect(slugs('jpeg')).toEqual(slugs('jpg'));
    expect(slugs('JPEG to PDF')).toEqual(slugs('jpg to pdf'));
    expect(slugs('pdf to jpeg')[0]).toBe('pdf-to-jpg');
    // Half-typed "jpeg" must not empty the list on the way there.
    expect(slugs('jpe')).toContain('pdf-to-jpg');
  });

  it('treats photo, picture and image as the same word', () => {
    expect(slugs('compress photo')[0]).toBe('compress-image');
    expect(slugs('resize picture')[0]).toBe('resize-image');
    expect(slugs('photos to pdf')[0]).toBe('image-to-pdf');
  });

  it('ignores filler words, but not when they are all that has been typed', () => {
    expect(slugs('how do i merge a pdf')[0]).toBe('merge-pdf');
    expect(slugs('pdf to')).toEqual(slugs('pdf'));
    expect(slugs('a')).toContain('add-page-numbers');
  });

  it('finds a size-specific task page however the size is written', () => {
    expect(slugs('compress pdf 100kb')[0]).toBe('compress-pdf-to-100kb');
    expect(slugs('compress pdf to 100 KB')[0]).toBe('compress-pdf-to-100kb');
    expect(slugs('50kb')[0]).toBe('compress-image-to-50kb');
  });

  it('ranks the tool above its task pages when only the tool is named', () => {
    const found = slugs('compress pdf');
    expect(found[0]).toBe('compress-pdf');
    expect(found).toEqual(expect.arrayContaining([
      'compress-pdf-to-100kb', 'compress-pdf-to-200kb', 'compress-pdf-to-1mb',
    ]));
  });

  it('finds a page by a format only its long description mentions', () => {
    expect(slugs('heic')[0]).toBe('heic-to-jpg');
    expect(slugs('heic')).toContain('image-to-pdf');
    expect(slugs('avif')).toContain('convert-image');
  });

  it('finds something for every query the "no results" message suggests', () => {
    for (const query of SUGGESTED_QUERIES) {
      expect(search(query).length, `"${query}"`).toBeGreaterThan(0);
    }
  });
});
