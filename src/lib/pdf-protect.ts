/**
 * Protect PDF: what the form's choices mean for the encrypted file.
 *
 * Kept free of WASM and DOM so the mapping from a ticked box to the bits in the
 * file can be unit-tested directly. It used to live nowhere: the worker passed a
 * fixed set of qpdf options and ignored the checkboxes entirely, so every file
 * came out the same whatever the visitor chose.
 */

/** What a visitor can allow or withhold on the Protect PDF form. */
export interface ProtectPermissions {
  print: boolean;
  copyContents: boolean;
  modifyContents: boolean;
  fillForms: boolean;
  annotations: boolean;
  assemble: boolean;
}

export type ProtectPermissionKey = keyof ProtectPermissions;

export const PROTECT_PERMISSION_KEYS: readonly ProtectPermissionKey[] = [
  'print',
  'copyContents',
  'modifyContents',
  'fillForms',
  'annotations',
  'assemble',
];

/**
 * Bit values of /P, the permission field of the encryption dictionary
 * (ISO 32000-1 table 22). A set bit grants the permission.
 */
export const PERMISSION_FLAG = {
  print: 1 << 2, // bit 3
  modify: 1 << 3, // bit 4
  copy: 1 << 4, // bit 5
  annotate: 1 << 5, // bit 6
  fillForms: 1 << 8, // bit 9
  accessibility: 1 << 9, // bit 10
  assemble: 1 << 10, // bit 11
  printHighQuality: 1 << 11, // bit 12
} as const;

/**
 * Bits that are 1 in every file: the reserved bits 7-8 and 13-32, plus
 * extraction for accessibility. PDF 2.0 deprecates withholding that last one
 * (qpdf ignores the request for AES-256), and a screen reader must never be
 * locked out by a "no copying" choice.
 */
const ALWAYS_SET = 0xfffff0c0 | PERMISSION_FLAG.accessibility;

/**
 * Fill in a possibly partial choice.
 *
 * - A permission that was not stated is withheld. Leaving one out must never
 *   quietly grant it.
 * - Allowing comments allows form filling too. The specification defines the
 *   annotation bit as "add or modify annotations, fill in form fields", so a
 *   conforming reader lets a commenter fill forms whatever the form bit says;
 *   recording them separately would promise a restriction that does not exist.
 */
export function resolvePermissions(choice: Partial<ProtectPermissions> | undefined): ProtectPermissions {
  const annotations = choice?.annotations === true;
  return {
    print: choice?.print === true,
    copyContents: choice?.copyContents === true,
    modifyContents: choice?.modifyContents === true,
    fillForms: choice?.fillForms === true || annotations,
    annotations,
    assemble: choice?.assemble === true,
  };
}

const yn = (allowed: boolean) => (allowed ? 'y' : 'n');

/**
 * The qpdf encryption options for a choice. Every option is always stated:
 * qpdf's own default for each is "allowed", so an omitted option would grant
 * the permission.
 */
export function permissionsToQpdfArgs(choice: Partial<ProtectPermissions> | undefined): string[] {
  const p = resolvePermissions(choice);
  return [
    `--print=${p.print ? 'full' : 'none'}`,
    `--extract=${yn(p.copyContents)}`,
    `--modify-other=${yn(p.modifyContents)}`,
    `--annotate=${yn(p.annotations)}`,
    `--form=${yn(p.fillForms)}`,
    `--assemble=${yn(p.assemble)}`,
  ];
}

/**
 * The signed /P integer a file carrying this choice must hold. Used to check
 * the encrypted output against what was asked for before it is handed back.
 */
export function permissionsToFlags(choice: Partial<ProtectPermissions> | undefined): number {
  const p = resolvePermissions(choice);
  let flags = ALWAYS_SET;
  if (p.print) flags |= PERMISSION_FLAG.print | PERMISSION_FLAG.printHighQuality;
  if (p.copyContents) flags |= PERMISSION_FLAG.copy;
  if (p.modifyContents) flags |= PERMISSION_FLAG.modify;
  if (p.annotations) flags |= PERMISSION_FLAG.annotate;
  if (p.fillForms) flags |= PERMISSION_FLAG.fillForms;
  if (p.assemble) flags |= PERMISSION_FLAG.assemble;
  return flags | 0;
}

/**
 * Why a pair of passwords cannot be used, or null when it can.
 *
 * A PDF has two passwords. The user password opens the file with the
 * restrictions in force; the owner password opens it with none. If they are
 * the same string, every reader treats whoever types it as the owner, and the
 * restrictions apply to no one. An empty owner password is refused for the
 * same reason. An empty user password is allowed: the file then opens without
 * a prompt, restricted.
 */
export function passwordProblem(userPassword: string, ownerPassword: string): string | null {
  if (!ownerPassword) return 'A permissions password is required.';
  if (ownerPassword === userPassword) {
    return 'The permissions password must be different from the password that opens the file.';
  }
  return null;
}

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

/** Length of a permissions password generated on the visitor's behalf. */
export const GENERATED_OWNER_PASSWORD_LENGTH = 24;

/**
 * A random password from the browser's CSPRNG. Bytes that would bias the
 * choice (256 is not a multiple of the alphabet size) are thrown away rather
 * than folded in with a modulo.
 */
export function generatePassword(length: number, alphabet: string = PASSWORD_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}
