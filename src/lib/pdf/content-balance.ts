/**
 * How many graphics states a page's own content leaves open.
 *
 * A content stream saves the graphics state with `q` and restores it with `Q`.
 * A well-formed page closes every `q` it opens, but files in the wild do not
 * always, and whatever is appended to such a page is drawn in the coordinate
 * system the page left behind — scaled, shifted or rotated.
 *
 * pdf-lib guards against the simple cases itself: before it appends anything it
 * wraps the existing content in one `q … Q`, which undoes a bare `cm` and one
 * unclosed `q`. It does not help when two or more states are left open (or a
 * `cm` is followed by an unclosed `q`): its single `Q` restores only the
 * innermost. The cure is to emit one extra `Q` per state the page left open
 * before drawing — and that count is what this function returns.
 *
 * Pure: bytes in, number out. It is a tokenizer, not a parser: it only has to
 * tell the operators `q` and `Q` from the same letters inside strings, names,
 * comments and inline image data.
 */

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

/** `( ) < > [ ] { } / %` */
const isDelimiter = (c: number) =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

const CHAR = { percent: 37, open: 40, close: 41, slash: 47, lt: 60, gt: 62, backslash: 92 } as const;
const LETTER = { D: 68, E: 69, I: 73, Q: 81, q: 113 } as const;

/**
 * The number of `q` operators not matched by a later `Q` in a page's decoded
 * content (all of its content streams, in order, joined by whitespace). A `Q`
 * with nothing to close is ignored, as viewers ignore it.
 */
export function countUnclosedGraphicsStates(content: Uint8Array): number {
  const n = content.length;
  let depth = 0;
  let i = 0;

  while (i < n) {
    const c = content[i];

    if (isWhite(c)) {
      i++;
    } else if (c === CHAR.percent) {
      // Comment: to the end of the line.
      while (i < n && content[i] !== 10 && content[i] !== 13) i++;
    } else if (c === CHAR.open) {
      // Literal string: parentheses nest, and a backslash escapes the next byte.
      let level = 1;
      i++;
      while (i < n && level > 0) {
        const d = content[i];
        if (d === CHAR.backslash) {
          i += 2;
          continue;
        }
        if (d === CHAR.open) level++;
        else if (d === CHAR.close) level--;
        i++;
      }
    } else if (c === CHAR.lt) {
      if (content[i + 1] === CHAR.lt) {
        i += 2; // `<<` opens a dictionary; its contents are ordinary tokens
      } else {
        // Hex string: to the closing `>`.
        while (i < n && content[i] !== CHAR.gt) i++;
        i++;
      }
    } else if (c === CHAR.slash) {
      // Name: `/q` is a name, not an operator.
      i++;
      while (i < n && !isWhite(content[i]) && !isDelimiter(content[i])) i++;
    } else if (isDelimiter(c)) {
      i++;
    } else {
      // A number, keyword or operator.
      const start = i;
      while (i < n && !isWhite(content[i]) && !isDelimiter(content[i])) i++;
      const length = i - start;
      if (length === 1 && content[start] === LETTER.q) {
        depth++;
      } else if (length === 1 && content[start] === LETTER.Q) {
        if (depth > 0) depth--;
      } else if (length === 2 && content[start] === LETTER.I && content[start + 1] === LETTER.D) {
        // Inline image: raw bytes follow `ID` up to an `EI` that stands alone.
        i++;
        while (i < n) {
          if (
            content[i] === LETTER.E &&
            content[i + 1] === LETTER.I &&
            isWhite(content[i - 1]) &&
            (i + 2 >= n || isWhite(content[i + 2]))
          ) {
            i += 2;
            break;
          }
          i++;
        }
      }
    }
  }
  return depth;
}
