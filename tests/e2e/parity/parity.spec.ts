import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../../../src/lib/tools-registry';
import { COVERAGE } from './coverage';

/**
 * Phase 7 — feature-parity gate.
 *
 * The audit found copy drift: the site advertised capabilities the code did not
 * have. These tests make that impossible to reintroduce silently. Every feature
 * bullet on every tool must be accounted for in coverage.ts, and every spec file
 * a bullet points at must actually exist.
 *
 * This does NOT require every bullet to be tested — see the header of
 * coverage.ts. It requires every bullet to have been *looked at*.
 */
const E2E_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.join(E2E_ROOT, '..', '..');

test.describe('P7 — feature parity: marketing copy vs. tested capability', () => {
  test('every tool in the registry has a coverage entry', () => {
    const missing = TOOLS.filter((t) => !COVERAGE[t.slug]).map((t) => t.slug);
    expect(missing, `tools with no entry in tests/e2e/parity/coverage.ts:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  test('coverage.ts has no entries for tools that no longer exist', () => {
    const slugs = new Set(TOOLS.map((t) => t.slug));
    const orphans = Object.keys(COVERAGE).filter((s) => !slugs.has(s));
    expect(orphans, `coverage entries for unknown tools:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  test('every advertised feature bullet is accounted for', () => {
    const unaccounted: string[] = [];
    for (const tool of TOOLS) {
      const entries = COVERAGE[tool.slug] ?? {};
      for (const feature of tool.features) {
        if (!(feature in entries)) unaccounted.push(`${tool.slug}: ${feature}`);
      }
    }
    expect(
      unaccounted,
      'These feature bullets are advertised but have no coverage entry.\n' +
        'Add them to tests/e2e/parity/coverage.ts — as covered/partial/unproven —\n' +
        'so the claim is a decision rather than an oversight:\n  ' +
        unaccounted.join('\n  ')
    ).toEqual([]);
  });

  test('coverage.ts has no stale bullets (copy reworded or removed)', () => {
    const stale: string[] = [];
    for (const tool of TOOLS) {
      const advertised = new Set(tool.features);
      for (const feature of Object.keys(COVERAGE[tool.slug] ?? {})) {
        if (!advertised.has(feature)) stale.push(`${tool.slug}: ${feature}`);
      }
    }
    expect(
      stale,
      'These coverage entries no longer match any advertised bullet — the copy was\n' +
        'reworded or dropped. Update tests/e2e/parity/coverage.ts to match:\n  ' +
        stale.join('\n  ')
    ).toEqual([]);
  });

  test('every spec a bullet cites actually exists', () => {
    const broken: string[] = [];
    for (const [slug, entries] of Object.entries(COVERAGE)) {
      for (const [feature, cov] of Object.entries(entries)) {
        for (const spec of cov.specs ?? []) {
          if (!existsSync(path.join(E2E_ROOT, spec))) broken.push(`${slug}: "${feature}" -> ${spec}`);
        }
        // Unit citations are repo-root relative, not tests/e2e relative.
        for (const unit of cov.units ?? []) {
          if (!existsSync(path.join(REPO_ROOT, unit))) broken.push(`${slug}: "${feature}" -> ${unit}`);
        }
      }
    }
    expect(broken, `coverage points at test files that do not exist:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  test('claims marked covered or partial cite at least one test', () => {
    const bare: string[] = [];
    for (const [slug, entries] of Object.entries(COVERAGE)) {
      for (const [feature, cov] of Object.entries(entries)) {
        const cited = (cov.specs?.length ?? 0) + (cov.units?.length ?? 0);
        if (cov.state !== 'unproven' && cited === 0) {
          bare.push(`${slug}: ${feature} (${cov.state})`);
        }
      }
    }
    expect(bare, `marked as tested but cite no test:\n  ${bare.join('\n  ')}`).toEqual([]);
  });

  /**
   * Not an assertion — a visible tally, so the proportion of the marketing copy
   * that is actually proven is reported on every run instead of being guessed at.
   */
  test('report parity coverage', () => {
    const tally = { covered: 0, partial: 0, unproven: 0 };
    const unprovenList: string[] = [];
    for (const [slug, entries] of Object.entries(COVERAGE)) {
      for (const [feature, cov] of Object.entries(entries)) {
        tally[cov.state]++;
        if (cov.state === 'unproven') unprovenList.push(`${slug}: ${feature} — ${cov.note}`);
      }
    }
    const total = tally.covered + tally.partial + tally.unproven;
    const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
    console.log(
      `\nFeature-parity coverage across ${total} advertised bullets:\n` +
        `  covered  ${String(tally.covered).padStart(3)}  ${pct(tally.covered)}\n` +
        `  partial  ${String(tally.partial).padStart(3)}  ${pct(tally.partial)}\n` +
        `  unproven ${String(tally.unproven).padStart(3)}  ${pct(tally.unproven)}\n\n` +
        `Unproven claims:\n  ${unprovenList.join('\n  ')}\n`
    );
    expect(total).toBeGreaterThan(0);
  });
});
