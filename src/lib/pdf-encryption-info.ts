/**
 * Read a PDF's standard-security-handler details straight from its bytes.
 *
 * The /Encrypt dictionary is the one dictionary a PDF may not hide: the spec
 * requires it to be reachable from the trailer and leaves its own values
 * unencrypted (otherwise nothing could bootstrap decryption). It also may not
 * live inside an object stream. So a plain byte scan is sound here, and it lets
 * the unlock tool describe a file's encryption without pulling in a WASM engine
 * or knowing the password.
 *
 * Only the standard handler (/Filter /Standard) is decoded. Anything else is
 * reported as encrypted with an unknown scheme rather than guessed at.
 */

export interface PdfPermissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
  printHighQuality: boolean;
}

export interface EncryptionInfo {
  encrypted: boolean;
  /** Human-readable cipher, e.g. "AES-256" or "RC4 128-bit". */
  algorithm: string;
  /** /V — the security handler version. */
  version?: number;
  /** /R — the standard handler revision. */
  revision?: number;
  /** Key length in bits. */
  keyLength?: number;
  /** /P exactly as stored: a signed 32-bit integer, one bit per permission. */
  permissionFlags?: number;
  permissions?: PdfPermissions;
}

const NOT_ENCRYPTED: EncryptionInfo = { encrypted: false, algorithm: 'None' };

/** Decode as latin1 so byte offsets and string indices stay aligned. */
function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function readInt(source: string, key: string): number | undefined {
  const m = new RegExp(`/${key}\\s+(-?\\d+)`).exec(source);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Decode /P, the permission bit-field. It is a signed 32-bit integer where a set
 * bit *grants* the permission, and bit positions are 1-based per the spec.
 */
function decodePermissions(p: number): PdfPermissions {
  const has = (bit: number) => (p & (1 << (bit - 1))) !== 0;
  return {
    print: has(3),
    modify: has(4),
    copy: has(5),
    annotate: has(6),
    fillForms: has(9),
    assemble: has(11),
    printHighQuality: has(12),
  };
}

function describeAlgorithm(version: number | undefined, revision: number | undefined, dict: string, keyLength: number): string {
  // V4/V5 name their cipher in a crypt filter rather than in /V itself.
  if (dict.includes('AESV3')) return 'AES-256';
  if (dict.includes('AESV2')) return 'AES-128';
  if (version === 5 || revision === 5 || revision === 6) return 'AES-256';
  if (version === 4) return `RC4 ${keyLength}-bit`;
  if (version === 1) return 'RC4 40-bit';
  if (version === 2 || version === 3) return `RC4 ${keyLength}-bit`;
  return 'Unknown';
}

/**
 * The text of the encryption dictionary that holds `/Filter /Standard`.
 *
 * Normally that is exactly one indirect object, so the scan is bounded to it:
 * the bytes just before it are the tail of another object's (encrypted) stream,
 * and a chance "/P 7" in that noise must not be read as this file's
 * permissions. When the object's edges cannot be found, a generous fixed window
 * is used instead — /O, /U, /OE and /UE hold long strings.
 */
function encryptionDictionary(text: string, filterIdx: number): string {
  const lookBehind = Math.max(0, filterIdx - 2048);
  const head = text.slice(lookBehind, filterIdx);
  const lastObj = head.lastIndexOf('obj');
  // "12 0 obj" opens an object; "endobj" closes the previous one.
  const opensHere = lastObj > 0 && /\s/.test(head[lastObj - 1]);
  const start = opensHere ? lookBehind + lastObj : Math.max(0, filterIdx - 512);

  const endObj = text.indexOf('endobj', filterIdx);
  const end = endObj !== -1 && endObj - filterIdx < 4096 ? endObj : filterIdx + 2048;
  return text.slice(start, end);
}

export function readEncryptionInfo(bytes: Uint8Array): EncryptionInfo {
  const text = toLatin1(bytes);

  // No /Encrypt reference in any trailer means no encryption at all.
  if (!/\/Encrypt\b/.test(text)) return NOT_ENCRYPTED;

  const filterIdx = text.search(/\/Filter\s*\/Standard\b/);
  if (filterIdx === -1) {
    return { encrypted: true, algorithm: 'Unknown (non-standard security handler)' };
  }

  const dict = encryptionDictionary(text, filterIdx);

  const version = readInt(dict, 'V');
  const revision = readInt(dict, 'R');
  const p = readInt(dict, 'P');
  // /Length is optional and defaults to 40 bits; V5 is always a 256-bit key.
  const keyLength = version === 5 ? 256 : (readInt(dict, 'Length') ?? 40);

  return {
    encrypted: true,
    algorithm: describeAlgorithm(version, revision, dict, keyLength),
    version,
    revision,
    keyLength,
    permissionFlags: p,
    permissions: p === undefined ? undefined : decodePermissions(p),
  };
}
