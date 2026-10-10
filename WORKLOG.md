# DocuKit work log

Append-only. The coordinator adds an entry after every integration to `main`: the date, the commit,
what changed for users, how it was verified, and anything left open. Newest entries at the bottom.
The brief and the backlog live in `HANDOFF.md`.

---

## 2026-10-10 — single-agent session (before the coordinator model)

| Commit | What shipped | Verified |
|---|---|---|
| `b17a806` | Canonicals, JSON-LD urls and internal links use trailing-slash URLs; `/view/` out of the sitemap | Build output; live canonicals and sitemap |
| `2c883d6` | `npm audit fix` (Astro 6.0.8 → 6.4.8 and others); 59 → 27 advisories | Typecheck, lint, unit tests, build |
| `489c45b` | Structured data reaches the page (missing `head` slot); per-tool share images; Organization schema | Build output; live JSON-LD and OG image |
| `ca6e044` | Security headers and CSP deploy from `public/_headers`; `serve-dist.mjs` applies them | 97 Chromium + 42 Firefox/WebKit tests under the CSP |
| `6ee3a8f` | Rearrange PDF: rotate a selection or all pages | New tests read output page rotations |
| `26cb86d` | 11 task landing pages + "Popular tasks" links + footer row | 283 Chromium tests from a clean worktree; all pages checked live |
| `e499422` | HEIC conversion fixed under the CSP (`heic-to/csp`); real HEIC fixture; thumbnail fallback | HEIC → JPG on three engines; converted a real file on the live site |
| `1a957a1` | Upload box keeps its height after a file is added | 162/162 with retries off on three engines |
| `c4b7e31` | HEIC to JPG task page | With the above |
| `c578f91` | Compress PDF: Target size mode | 300 Chromium + 68 Firefox/WebKit; 46.9 KB → 21.6 KB at a 30 KB target on the live site |
| `9b2ee7e` | Compress PDF to 100KB / 200KB / 1MB task pages | With the above |
| `c61ae27` | Astro 6 → 7 (Vite 8) to clear the last critical advisory | 301 Chromium, 269 Firefox/WebKit, 22 mobile; five tools run on the live site in Chromium and WebKit; CI `ci` job green |

### Mistake worth remembering

`ca6e044` shipped a CSP without `'unsafe-eval'`, which broke HEIC conversion in production for about
two and a half hours. No test covered HEIC because there was no fixture, so the suite stayed green.
It was found only when a real HEIC file was created for another reason. Lesson: an "unproven" entry in
`coverage.ts` is a blind spot for exactly this kind of change — when tightening a policy or upgrading
a dependency, exercise the unproven features by hand.

### Left open at the end of the session

- The uncommitted source-check work in the working tree (HANDOFF.md §1.1) — needs Lakshay's decision.
- Merge PDF page-level view and Split PDF visual preview: designed (HANDOFF.md T1, T2), not started.
- Cloudflare Web Analytics is still switched on in the dashboard and is blocked by the CSP.
- CI `e2e` job for `c61ae27` was still running when the session ended.
