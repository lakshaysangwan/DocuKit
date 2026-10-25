/**
 * Lock Image: the file format, and the code that makes it.
 *
 * The output is one HTML file. It holds the image, byte for byte as it was
 * added, encrypted with AES-256-GCM under a key derived from the password with
 * PBKDF2-HMAC-SHA-256, plus the few lines of script that ask for the password
 * and decrypt it again in whatever browser opens the file. Nothing is uploaded:
 * the encryption happens here, and the decryption happens in the file.
 *
 * In the file:
 *
 *   <script type="application/json" id="docukit-lock">   the header (below)
 *   <script type="text/plain" id="docukit-data">          the ciphertext, base64
 *
 * Header (`LockHeader`): format version, KDF and its parameters, the random
 * salt (16 bytes) and IV (12 bytes) in base64, and the image's type and file
 * extension, so the file can show it and name it when it is saved. The type is
 * the one read from the image's own first bytes, never the file name. The
 * original file name is not stored.
 *
 * `unlockImage` is the same decryption as the script in the file, for tests.
 */

export const LOCK_VERSION = 2;
/** OWASP's current figure for PBKDF2-HMAC-SHA-256. */
export const LOCK_ITERATIONS = 600_000;
export const LOCK_SALT_BYTES = 16;
export const LOCK_IV_BYTES = 12;

/** The image types Lock Image takes, read from the file's first bytes. */
export const LOCK_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
};

/** Types most browsers can show, so the unlocked image appears in the page; others are offered to save. */
export const LOCK_SHOWN_EVERYWHERE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];

export interface LockHeader {
  v: number;
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  cipher: 'AES-GCM';
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  type: string;
  ext: string;
}

export interface Locked {
  header: LockHeader;
  cipher: Uint8Array;
}

/* ── base64 ─────────────────────────────────────────────────────────────── */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── crypto ─────────────────────────────────────────────────────────────── */

async function deriveKey(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/**
 * Encrypt an image with a password. `type` must be one of `LOCK_TYPES` (the
 * type sniffed from the bytes). A fresh random salt and IV every time.
 */
export async function lockImage(
  bytes: Uint8Array | ArrayBuffer,
  type: string,
  password: string,
  iterations = LOCK_ITERATIONS,
): Promise<Locked> {
  const ext = LOCK_TYPES[type];
  if (!ext) throw new Error('This file is not an image Lock Image can lock.');
  if (!password) throw new Error('Type a password.');
  const salt = crypto.getRandomValues(new Uint8Array(LOCK_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(LOCK_IV_BYTES));
  const key = await deriveKey(password, salt, iterations, 'encrypt');
  const plain = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  return {
    header: {
      v: LOCK_VERSION,
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      cipher: 'AES-GCM',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      type,
      ext,
    },
    cipher,
  };
}

/** Decrypt — what the script in the locked file does. Throws on a wrong password. */
export async function unlockImage(locked: Locked, password: string): Promise<Uint8Array> {
  const { header } = locked;
  const key = await deriveKey(password, base64ToBytes(header.salt), header.iterations, 'decrypt');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(header.iv) as BufferSource },
    key,
    locked.cipher as BufferSource,
  );
  return new Uint8Array(plain);
}

/* ── the file ───────────────────────────────────────────────────────────── */

/** `holiday.jpg` → `holiday-locked.html`. */
export function lockedFileName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '') || 'image';
  return `${stem}-locked.html`;
}

/** JSON that is safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Base64 in lines of 76, so the file opens in a text editor without one enormous line. */
function wrap(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\n');
}

const STYLE = `*{box-sizing:border-box;margin:0;padding:0}
html{color-scheme:light dark}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#f4f5f7;color:#111827;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px}
main.open{max-width:min(96vw,1400px)}
h1{font-size:18px;margin-bottom:6px}
p{color:#4b5563;font-size:14px;margin-bottom:14px}
label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
input{width:100%;height:44px;padding:0 12px;border:1px solid #d1d5db;border-radius:10px;font:inherit;background:#fff;color:#111827;margin-bottom:12px}
input:focus{outline:2px solid #1a56db;outline-offset:1px}
button,a.save{display:inline-flex;align-items:center;justify-content:center;width:100%;height:44px;border:0;border-radius:10px;background:#111827;color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button:disabled{opacity:.5;cursor:wait}
.err{color:#b91c1c;font-weight:600;margin:12px 0 0;min-height:1em}
img{display:block;max-width:100%;max-height:78vh;margin:0 auto 16px;border-radius:8px}
.foot{margin:16px 0 0;font-size:12px;color:#6b7280}
@media (prefers-color-scheme:dark){body{background:#0b0f19;color:#f3f4f6}main{background:#111827;border-color:#1f2937}p{color:#9ca3af}input{background:#0b0f19;color:#f3f4f6;border-color:#374151}button,a.save{background:#f3f4f6;color:#111827}.err{color:#f87171}}`;

// The script in the file. Plain ES2017 so any current browser runs it; it reads
// the header and data from the two script elements above it.
const SCRIPT = `(function(){
var H=JSON.parse(document.getElementById('docukit-lock').textContent);
var D=document.getElementById('docukit-data').textContent;
var form=document.getElementById('form'),pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
function bytes(s){var t=atob(s.replace(/\\s+/g,'')),u=new Uint8Array(t.length);for(var i=0;i<t.length;i++)u[i]=t.charCodeAt(i);return u;}
function stem(){try{var n=decodeURIComponent(location.pathname.split('/').pop()||'');n=n.replace(/\\.html?$/i,'').replace(/-locked$/i,'');return n||'image';}catch(e){return 'image';}}
form.addEventListener('submit',function(e){e.preventDefault();unlock();});
async function unlock(){
  err.textContent='';
  if(!pw.value){err.textContent='Type the password.';return;}
  if(!window.crypto||!crypto.subtle){err.textContent='This browser will not decrypt here. Save the file and open it directly in Chrome, Edge, Firefox or Safari.';return;}
  go.disabled=true;go.textContent='Unlocking\\u2026';
  var plain;
  try{
    var m=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw.value),{name:'PBKDF2'},false,['deriveKey']);
    var k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes(H.salt),iterations:H.iterations,hash:H.hash},m,{name:'AES-GCM',length:256},false,['decrypt']);
    plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(H.iv)},k,bytes(D));
  }catch(e){
    go.disabled=false;go.textContent='Unlock image';
    err.textContent='Wrong password, or the file has been changed. Try again.';
    pw.select();return;
  }
  var url=URL.createObjectURL(new Blob([plain],{type:H.type}));
  var img=document.getElementById('img'),save=document.getElementById('save'),cant=document.getElementById('cant');
  img.onerror=function(){img.hidden=true;cant.hidden=false;};
  img.src=url;save.href=url;save.download=stem()+'.'+H.ext;
  document.getElementById('lock').hidden=true;document.getElementById('out').hidden=false;
  document.querySelector('main').className='open';save.focus();
}
})();`;

/** The locked HTML file. */
export function buildLockedHtml({ header, cipher }: Locked): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Locked image</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div id="lock">
<h1>Locked image</h1>
<p>This file holds an image locked with a password. Type the password to see it. It is decrypted here, in this browser; nothing is sent anywhere.</p>
<noscript><p class="err">Open this file in a web browser with scripts on (Chrome, Edge, Firefox or Safari). A preview in a mail or chat app cannot unlock it.</p></noscript>
<form id="form">
<label for="pw">Password</label>
<input type="password" id="pw" autocomplete="off" autofocus>
<button type="submit" id="go">Unlock image</button>
</form>
<p class="err" id="err" role="alert"></p>
</div>
<div id="out" hidden>
<img id="img" alt="The unlocked image">
<p id="cant" hidden>This browser cannot show this kind of image. Save it and open it with an app that can.</p>
<a class="save" id="save" href="#">Save image</a>
</div>
<p class="foot">Locked with Lock Image on docukit.uk: AES-256-GCM, with the key made from the password by PBKDF2-SHA-256 (${header.iterations.toLocaleString('en-US')} rounds).</p>
</main>
<script type="application/json" id="docukit-lock">${scriptJson(header)}</script>
<script type="text/plain" id="docukit-data">
${wrap(bytesToBase64(cipher))}
</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Read a locked file back (for tests and for checking a file). Throws if it is not one. */
export function parseLockedHtml(html: string): Locked {
  const head = /<script type="application\/json" id="docukit-lock">([\s\S]*?)<\/script>/.exec(html);
  const data = /<script type="text\/plain" id="docukit-data">([\s\S]*?)<\/script>/.exec(html);
  if (!head || !data) throw new Error('Not a locked image file.');
  const header = JSON.parse(head[1]) as LockHeader;
  return { header, cipher: base64ToBytes(data[1]) };
}

/* ── password strength ──────────────────────────────────────────────────── */

export interface Strength {
  /** 0–4 */
  score: number;
  label: 'Very weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
}

const LABELS: Strength['label'][] = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];

/**
 * A rough guide, from length and the kinds of character used. It cannot know
 * whether a password is a common one, so it is only a guide.
 */
export function passwordStrength(pw: string): Strength {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  // Short passwords stay weak however mixed they are.
  if (pw.length < 8) score = Math.min(score, 1);
  const s = Math.min(score, 4);
  return { score: s, label: LABELS[s] };
}
