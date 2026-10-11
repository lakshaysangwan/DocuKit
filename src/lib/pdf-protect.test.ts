import { describe, it, expect } from 'vitest';
import {
  PERMISSION_FLAG,
  PROTECT_PERMISSION_KEYS,
  generatePassword,
  passwordProblem,
  permissionsToFlags,
  permissionsToQpdfArgs,
  resolvePermissions,
  type ProtectPermissions,
} from './pdf-protect';

/**
 * Protect PDF once ignored its permission checkboxes: the worker passed qpdf a
 * fixed `--print=none --modify=none`, so every file allowed copying and forbade
 * printing whatever was ticked. The mapping from a choice to qpdf options and
 * to the /P bits is pinned here, value by value. (That qpdf really writes those
 * bits is proven end to end in tests/e2e/tools/protect-pdf-permissions.spec.ts.)
 */

const NONE: ProtectPermissions = {
  print: false, copyContents: false, modifyContents: false, fillForms: false, annotations: false, assemble: false,
};
const ALL: ProtectPermissions = {
  print: true, copyContents: true, modifyContents: true, fillForms: true, annotations: true, assemble: true,
};

/** Reserved bits 7-8 and 13-32, which are 1 in every file. */
const RESERVED = 0xfffff0c0;
const granted = (choice: Partial<ProtectPermissions> | undefined) => (permissionsToFlags(choice) & ~RESERVED) >>> 0;

describe('permissionsToFlags', () => {
  it('writes the values qpdf writes for nothing and for everything', () => {
    // Read from real qpdf 12.2 output: `/P -3392` and `/P -4`.
    expect(permissionsToFlags(NONE)).toBe(-3392);
    expect(permissionsToFlags(ALL)).toBe(-4);
  });

  it('never withholds extraction for accessibility', () => {
    expect(granted(NONE)).toBe(PERMISSION_FLAG.accessibility);
  });

  it.each([
    ['print', PERMISSION_FLAG.print | PERMISSION_FLAG.printHighQuality],
    ['copyContents', PERMISSION_FLAG.copy],
    ['modifyContents', PERMISSION_FLAG.modify],
    ['fillForms', PERMISSION_FLAG.fillForms],
    // Commenting carries form filling with it.
    ['annotations', PERMISSION_FLAG.annotate | PERMISSION_FLAG.fillForms],
    ['assemble', PERMISSION_FLAG.assemble],
  ] as const)('allowing only %s grants exactly its own bits', (key, bits) => {
    expect(granted({ ...NONE, [key]: true })).toBe((bits | PERMISSION_FLAG.accessibility) >>> 0);
  });

  it.each([
    ['print', PERMISSION_FLAG.print | PERMISSION_FLAG.printHighQuality],
    ['copyContents', PERMISSION_FLAG.copy],
    ['modifyContents', PERMISSION_FLAG.modify],
    ['annotations', PERMISSION_FLAG.annotate],
    ['assemble', PERMISSION_FLAG.assemble],
  ] as const)('withholding only %s clears exactly its own bits', (key, bits) => {
    expect(granted({ ...ALL, [key]: false })).toBe((granted(ALL) & ~bits) >>> 0);
  });

  it('treats a permission that was not stated as withheld', () => {
    expect(permissionsToFlags(undefined)).toBe(permissionsToFlags(NONE));
    expect(permissionsToFlags({})).toBe(permissionsToFlags(NONE));
    expect(granted({ copyContents: true })).toBe(PERMISSION_FLAG.copy | PERMISSION_FLAG.accessibility);
  });
});

describe('resolvePermissions', () => {
  it('allows form filling whenever commenting is allowed', () => {
    expect(resolvePermissions({ ...NONE, annotations: true }).fillForms).toBe(true);
    expect(resolvePermissions({ ...ALL, fillForms: false }).fillForms).toBe(true);
  });

  it('lets form filling stand alone without commenting', () => {
    const p = resolvePermissions({ ...NONE, fillForms: true });
    expect(p.fillForms).toBe(true);
    expect(p.annotations).toBe(false);
  });

  it('leaves every other choice exactly as given', () => {
    expect(resolvePermissions(NONE)).toEqual(NONE);
    expect(resolvePermissions(ALL)).toEqual(ALL);
  });
});

describe('permissionsToQpdfArgs', () => {
  it('states every option, so qpdf never falls back to its allow-by-default', () => {
    for (const choice of [NONE, ALL, undefined, {}]) {
      const args = permissionsToQpdfArgs(choice);
      for (const option of ['--print=', '--extract=', '--modify-other=', '--annotate=', '--form=', '--assemble=']) {
        expect(args.filter((a) => a.startsWith(option)), `${option} for ${JSON.stringify(choice)}`).toHaveLength(1);
      }
    }
  });

  it('maps each choice to its own qpdf option', () => {
    expect(permissionsToQpdfArgs(NONE)).toEqual([
      '--print=none', '--extract=n', '--modify-other=n', '--annotate=n', '--form=n', '--assemble=n',
    ]);
    expect(permissionsToQpdfArgs(ALL)).toEqual([
      '--print=full', '--extract=y', '--modify-other=y', '--annotate=y', '--form=y', '--assemble=y',
    ]);
    expect(permissionsToQpdfArgs({ ...ALL, copyContents: false })).toContain('--extract=n');
    expect(permissionsToQpdfArgs({ ...NONE, print: true })).toContain('--print=full');
  });

  it('covers every key the form offers', () => {
    // Flipping any single key must change the options — none is dead.
    for (const key of PROTECT_PERMISSION_KEYS) {
      const off = permissionsToQpdfArgs({ ...NONE, [key]: false }).join(' ');
      const on = permissionsToQpdfArgs({ ...NONE, [key]: true }).join(' ');
      expect(on, key).not.toBe(off);
    }
  });
});

describe('passwordProblem', () => {
  it('refuses an owner password equal to the open password', () => {
    expect(passwordProblem('same', 'same')).toMatch(/different/);
  });

  it('refuses an empty owner password, with or without an open password', () => {
    expect(passwordProblem('open', '')).not.toBeNull();
    expect(passwordProblem('', '')).not.toBeNull();
  });

  it('accepts distinct passwords, and no open password at all', () => {
    expect(passwordProblem('open', 'owner')).toBeNull();
    expect(passwordProblem('', 'owner')).toBeNull();
  });
});

describe('generatePassword', () => {
  it('returns the requested length from the given alphabet', () => {
    const pw = generatePassword(24);
    expect(pw).toHaveLength(24);
    expect(generatePassword(200, 'ab')).toMatch(/^[ab]{200}$/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword(24)));
    expect(seen.size).toBe(50);
  });
});
