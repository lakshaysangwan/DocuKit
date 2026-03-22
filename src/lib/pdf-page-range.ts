/**
 * Parse a page range string like "1-5, 8, 12-last, odd, even, first, last"
 * into a sorted, deduplicated array of 0-indexed page numbers.
 *
 * @param input   The range string entered by the user
 * @param total   Total number of pages in the document
 * @returns       Array of 0-indexed page indices, sorted ascending
 */
export function parsePageRange(input: string, total: number): number[] {
  if (!input.trim()) return [];

  const pages = new Set<number>();
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const lower = part.toLowerCase();

    if (lower === 'all') {
      for (let i = 0; i < total; i++) pages.add(i);
    } else if (lower === 'odd') {
      for (let i = 0; i < total; i += 2) pages.add(i);        // 0-indexed: pages 1,3,5... = indices 0,2,4
    } else if (lower === 'even') {
      for (let i = 1; i < total; i += 2) pages.add(i);        // 0-indexed: pages 2,4,6... = indices 1,3,5
    } else if (lower === 'first') {
      if (total > 0) pages.add(0);
    } else if (lower === 'last') {
      if (total > 0) pages.add(total - 1);
    } else if (lower.includes('-')) {
      const [startStr, endStr] = lower.split('-').map(s => s.trim());
      const start = startStr === 'first' ? 1 : parseInt(startStr, 10);
      const end = endStr === 'last' ? total : parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        const s = Math.max(1, start);
        const e = Math.min(total, end);
        for (let i = s; i <= e; i++) pages.add(i - 1); // convert to 0-indexed
      }
    } else {
      const n = parseInt(lower, 10);
      if (!isNaN(n) && n >= 1 && n <= total) {
        pages.add(n - 1); // convert to 0-indexed
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Convert a page range string into multiple ranges (for Split by Range mode).
 * Input: "1-5, 6-10, 11-20"
 * Returns: [[0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14,15,16,17,18,19]]
 */
export function parseMultiRanges(input: string, total: number): number[][] {
  return input
    .split(',')
    .map(part => parsePageRange(part.trim(), total))
    .filter(r => r.length > 0);
}

/**
 * Format a page range array back to human-readable string (for display)
 * e.g. [0,1,2,4,6,7] → "1-3, 5, 7-8"
 */
export function formatPageRange(pages: number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
      if (i < sorted.length) {
        start = sorted[i];
        end = sorted[i];
      }
    }
  }

  return ranges.join(', ');
}
