import type { ToolCategory, ToolDef } from './tools-registry';

/**
 * Homepage search over every page a visitor can jump to: the tools in TOOLS and
 * the task pages in LANDING_PAGES.
 *
 * The index is derived from those two lists when the site is built — there is no
 * second list to keep in step. This module only imports the registry's *types*,
 * so the search island can import the matcher without pulling the registry's
 * FAQ and how-to copy into the homepage's JavaScript.
 */
export interface SearchEntry {
  slug: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** The phrase people look this page up by (`primaryKeyword`). */
  keyword: string;
  /** Other words from the heading and long description, normalised and deduped. */
  extra: string;
  /** Other phrases people search for this page by (`searchKeywords`), comma-separated. Never shown. */
  synonyms: string;
}

/**
 * The queries the "no results" message suggests trying. tool-search.test.ts
 * checks each of them really does find something.
 */
export const SUGGESTED_QUERIES = ['jpg', 'merge', 'password'] as const;

/** Every URL the site emits ends in a slash. */
export function entryHref(entry: Pick<SearchEntry, 'slug'>): string {
  return `/${entry.slug}/`;
}

/**
 * Words that carry no meaning in a query ("pdf to jpg", "how do I merge a pdf").
 * They never rule a page out — unless they are all the visitor has typed so far.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'how', 'i', 'in',
  'into', 'is', 'it', 'my', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'with',
  'you', 'your',
]);

/**
 * Different spellings of the same thing. A page that mentions one answers to all
 * of them; the first of each group is the form phrases are compared in.
 */
const VARIANTS: readonly (readonly string[])[] = [
  ['jpg', 'jpeg'],
  ['heic', 'heif'],
  ['image', 'photo', 'picture'],
];

const VARIANTS_OF = new Map<string, readonly string[]>();
for (const group of VARIANTS) for (const word of group) VARIANTS_OF.set(word, group);

/** "pages" → "page". Applied to the index and the query alike. */
function singular(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

/**
 * Lower-case words with accents, punctuation and plurals removed. A number is
 * split from the unit written against it, so "100KB", "100 kb" and "100-KB" all
 * read as `100`, `kb`.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)(?=[a-z])|([a-z])(?=\d)/g, '$1$2 ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

function canonical(token: string): string {
  return VARIANTS_OF.get(token)?.[0] ?? token;
}

/** The meaningful words of a phrase, in order, in their canonical spelling. */
function phraseKey(tokens: readonly string[]): string {
  return tokens.filter((t) => !STOP_WORDS.has(t)).map(canonical).join(' ');
}

/** Build the index from registry entries — tools and task pages alike. */
export function buildSearchIndex(pages: readonly ToolDef[]): SearchEntry[] {
  return pages.map((page) => {
    const seen = new Set([
      ...tokenize(page.name),
      ...tokenize(page.shortDescription),
      ...tokenize(page.primaryKeyword),
    ]);
    const extra: string[] = [];
    for (const token of tokenize(`${page.h1} ${page.longDescription}`)) {
      if (seen.has(token) || STOP_WORDS.has(token)) continue;
      seen.add(token);
      extra.push(token);
    }
    return {
      slug: page.slug,
      name: page.name,
      description: page.shortDescription,
      category: page.category,
      keyword: page.primaryKeyword,
      extra: extra.join(' '),
      synonyms: (page.searchKeywords ?? []).map((phrase) => {
        if (phrase.includes(',')) throw new Error(`search index: ${page.slug} keyword "${phrase}" contains a comma`);
        return phrase;
      }).join(','),
    };
  });
}

/**
 * The index travels to the browser as one of the search island's props. As an
 * array of objects it more than doubles in size on the way (Astro tags every
 * value with its type and the attribute escapes every quote), so it is sent as
 * plain text instead: one page per line, fields separated by tabs.
 */
const FIELD_ORDER = ['slug', 'name', 'description', 'category', 'keyword', 'extra', 'synonyms'] as const;

export function serializeSearchIndex(entries: readonly SearchEntry[]): string {
  return entries
    .map((entry) => FIELD_ORDER.map((field) => {
      const value = entry[field];
      // Fails the build rather than shipping an index that parses into nonsense.
      if (/[\t\n\r]/.test(value)) {
        throw new Error(`search index: ${entry.slug}.${field} contains a tab or line break`);
      }
      return value;
    }).join('\t'))
    .join('\n');
}

export function parseSearchIndex(text: string): SearchEntry[] {
  if (text === '') return [];
  return text.split('\n').map((line) => {
    const [slug = '', name = '', description = '', category = '', keyword = '', extra = '', synonyms = ''] = line.split('\t');
    return { slug, name, description, category: category === 'image' ? 'image' : 'pdf', keyword, extra, synonyms };
  });
}

/** How much a query word found in each field is worth: [whole word, start of a word]. */
const FIELD_WEIGHTS = {
  name: [12, 9],
  keyword: [8, 6],
  synonyms: [8, 6],
  description: [5, 4],
  extra: [2, 1],
} as const;

type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

interface PreparedEntry {
  entry: SearchEntry;
  words: Record<Field, string[]>;
  nameKey: string;
  keywordKey: string;
  synonymKeys: string[];
}

/** A field's words, each alongside its other spellings. */
function fieldWords(text: string): string[] {
  return tokenize(text).flatMap((token) => VARIANTS_OF.get(token) ?? [token]);
}

function prepare(entry: SearchEntry): PreparedEntry {
  return {
    entry,
    words: {
      name: fieldWords(entry.name),
      keyword: fieldWords(entry.keyword),
      description: fieldWords(entry.description),
      extra: fieldWords(entry.extra),
      synonyms: fieldWords(entry.synonyms),
    },
    nameKey: phraseKey(tokenize(entry.name)),
    keywordKey: phraseKey(tokenize(entry.keyword)),
    synonymKeys: entry.synonyms.split(',').map((phrase) => phraseKey(tokenize(phrase))).filter(Boolean),
  };
}

/** The best field a query word is found in, or 0 if the page never mentions it. */
function wordScore(prepared: PreparedEntry, word: string): number {
  let best = 0;
  for (const field of FIELDS) {
    const [whole, start] = FIELD_WEIGHTS[field];
    const words = prepared.words[field];
    if (words.includes(word)) best = Math.max(best, whole);
    else if (words.some((w) => w.startsWith(word))) best = Math.max(best, start);
  }
  return best;
}

function score(prepared: PreparedEntry, words: readonly string[], queryKey: string): number {
  let total = 0;
  for (const word of words) {
    const found = wordScore(prepared, word);
    // Every word has to be found somewhere — "merge jpg" is not "merge pdf".
    if (found === 0) return 0;
    total += found;
  }

  // Word order: "jpg to pdf" and "pdf to jpg" contain the same words.
  const { nameKey, keywordKey } = prepared;
  if (nameKey === queryKey) total += 40;
  else if (nameKey.startsWith(queryKey)) total += 20;
  else if (` ${nameKey}`.includes(` ${queryKey}`)) total += 10;

  if (keywordKey === queryKey) total += 15;
  else if (keywordKey.startsWith(queryKey)) total += 8;

  // "remove password" is Unlock's phrase, not just two words Protect also uses.
  if (prepared.synonymKeys.includes(queryKey)) total += 15;

  return total;
}

/**
 * Returns a function that ranks the entries against a query, best match first.
 *
 * A page matches when every meaningful word of the query is a word — or the
 * start of one — in its name, keyword or descriptions, so results narrow as the
 * visitor types instead of appearing only once a word is complete. An empty
 * query matches nothing: the tool grid already lists everything.
 */
export function createSearch(entries: readonly SearchEntry[]): (query: string) => SearchEntry[] {
  const prepared = entries.map(prepare);

  return (query) => {
    const tokens = tokenize(query);
    const meaningful = tokens.filter((t) => !STOP_WORDS.has(t));
    const words = meaningful.length > 0 ? meaningful : tokens;
    if (words.length === 0) return [];
    const queryKey = words.map(canonical).join(' ');

    return prepared
      .map((p, order) => ({ entry: p.entry, order, score: score(p, words, queryKey) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((r) => r.entry);
  };
}
