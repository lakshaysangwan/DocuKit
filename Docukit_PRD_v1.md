# Docukit — Product Requirements Document v1.0

**Client-Side PDF & Image Processing Platform**

| Field | Value |
|---|---|
| Version | 1.0 |
| Date | March 2026 |
| Classification | Internal — Confidential |
| Deployment | Cloudflare Pages (Static) + Cloudflare Workers (View-Once only) |
| Architecture | Zero-Backend, 100% Client-Side Processing |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision & Positioning](#2-product-vision--positioning)
3. [Technical Architecture](#3-technical-architecture)
4. [Frontend Stack & Design System](#4-frontend-stack--design-system)
5. [Animation & Interaction System](#5-animation--interaction-system)
6. [Feature Specifications](#6-feature-specifications)
7. [SEO Strategy](#7-seo-strategy)
8. [Security Hardening](#8-security-hardening)
9. [Performance Requirements](#9-performance-requirements)
10. [Accessibility](#10-accessibility)
11. [Deployment & Infrastructure](#11-deployment--infrastructure)
12. [Monetization (Phase 2)](#12-monetization-phase-2)
13. [Development Roadmap](#13-development-roadmap)
14. [Risk Register](#14-risk-register)
15. [Appendix](#15-appendix)

---

## 1. Executive Summary

### 1.1 Problem Statement

Existing free PDF/image tools (Smallpdf, ILovePDF, PDF24) upload user files to remote servers. This creates privacy concerns, introduces latency for large files, imposes daily usage caps, and feels "sketchy" with aggressive ad placements and dark patterns. Enterprise users avoid them due to data governance. Developers and students use them reluctantly.

### 1.2 Solution

Docukit processes every file 100% client-side in the user's browser. The site is a static app on Cloudflare Pages — no backend, no file uploads, no cookies, no tracking. Files never leave the browser sandbox. The product earns trust through transparency (open processing pipeline verifiable in DevTools), speed (WebAssembly-powered), and a polished UI that signals professionalism.

### 1.3 Key Differentiators

- **Zero-upload architecture**: all processing in-browser via WebAssembly + Web Workers
- **Cryptographic PDF signing**: self-signed or user-uploaded CA certificates — not just visual stamps
- **No usage caps, no accounts, no paywalls** for core features
- **Sub-second cold start** on Cloudflare's edge network (300+ PoPs)
- **SEO-first architecture** with dedicated pre-rendered landing pages per tool
- **Security-hardened**: CSP, SRI, no eval(), WASM sandboxed, verifiable by anyone in DevTools

### 1.4 Success Metrics

| Metric | 6-Month Target | 12-Month Target |
|---|---|---|
| Monthly Organic Sessions | 50,000 | 250,000 |
| Avg. Operations / Session | 2.3 | 3.1 |
| Core Web Vitals (all green) | 100% | 100% |
| Lighthouse SEO Score | ≥ 95 | 100 |
| Bounce Rate | < 45% | < 35% |
| Time on Site (avg) | > 2 min | > 3 min |
| Tool Completion Rate | > 80% | > 90% |

---

## 2. Product Vision & Positioning

### 2.1 Vision

Become the default free PDF and image toolkit that professionals trust by **proving** — not just claiming — that files never leave the browser.

### 2.2 Target Audience

| Segment | Needs | Current Pain |
|---|---|---|
| Students & Researchers | Merge assignments, compress for email, sign forms | Free tools have daily caps; privacy concerns with thesis drafts |
| Freelancers & Creators | Watermark portfolios, compress client images, sign contracts | Paying for Adobe for occasional PDF edits |
| Developers & Engineers | Quick PDF/image ops without CLI tools | Distrust random websites with source code or credentials |
| Small Business / HR | Redact PII, add page numbers, password-protect | Enterprise tools too expensive; free tools feel insecure |
| Legal / Finance | Cryptographically sign PDFs, redact sensitive data | Need verifiable signatures without Adobe Acrobat licenses |

### 2.3 Competitive Landscape

| Feature | Docukit | Smallpdf | ILovePDF | PDF24 | Adobe Acrobat |
|---|---|---|---|---|---|
| 100% Client-Side | ✅ Full | ❌ Server | ❌ Server | ❌ Server | ❌ Desktop |
| Cryptographic Signing | ✅ Self-signed + CA certs | ❌ | ❌ | ❌ | ✅ |
| Free Usage Caps | None | 2/day | Limited | Unlimited* | Paid |
| Account Required | No | Yes | No | No | Yes |
| Redaction (true removal) | ✅ | ❌ | ❌ | ❌ | ✅ |
| Image Tools Suite | ✅ Full | Basic | Basic | ❌ | Limited |
| View-Once Image Links | ✅ E2E Encrypted | ❌ | ❌ | ❌ | ❌ |
| Open Source | ✅ (planned) | ❌ | ❌ | ❌ | ❌ |

---

## 3. Technical Architecture

### 3.1 Core Principle: Zero-Backend

The entire application is a static site deployed on Cloudflare Pages. No backend server, no API, no database — except a minimal Cloudflare KV store for the single view-once image link feature. All PDF and image processing happens in the browser using WebAssembly libraries running inside Web Workers.

### 3.2 Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Meta-Framework** | **Astro 5** (hybrid SSG + islands) | Static HTML output for SEO; ships zero JS by default; React islands only where needed |
| **UI Framework** | **React 19** (island components) | Best ecosystem for complex interactive tools; concurrent rendering for smooth UX |
| **Styling** | **Tailwind CSS 4 + shadcn/ui** | Utility-first, consistent design system, accessible primitives |
| **Animations** | **Framer Motion 12 + GSAP + Lottie** | FM for component animations; GSAP for scroll effects; Lottie for loading states |
| **Routing** | **Astro file-based routing** | Each tool = its own pre-rendered HTML page; automatic code splitting |
| **PDF Engine** | **pdf-lib + PDF.js + MUPDF WASM** | pdf-lib for creation/editing, PDF.js for rendering, MUPDF for heavy ops |
| **PDF Signing** | **node-forge + @signpdf/signpdf** | Self-signed X.509 cert generation + PKCS#7 signature embedding |
| **Image Engine** | **Sharp WASM + Canvas API + Fabric.js** | Sharp for compression/resize, Canvas for manipulation, Fabric.js for annotation editor |
| **Signature Drawing** | **signature_pad.js** | Mature Bezier-smoothed drawing library; pressure-sensitive on supported devices |
| **Search** | **Fuse.js** | Client-side fuzzy search with configurable thresholds |
| **Drag & Drop** | **dnd-kit** | Accessible, performant, React-native DnD |
| **Encryption** | **Web Crypto API + node-forge** | Native AES-256-GCM; forge for X.509/PKCS operations |
| **State Management** | **Zustand** | Minimal, fast, no boilerplate |
| **Hosting** | **Cloudflare Pages** | Free tier, global CDN, edge functions for KV |
| **Analytics** | **Cloudflare Web Analytics** | Privacy-first, no cookies, free, lightweight |
| **Edge Functions** | **Cloudflare Workers** (view-once only) | KV store for ephemeral encrypted image links |

### 3.3 Why Astro + React (Not Pure React SPA)

A pure React SPA with Vite is poorly indexed by Google — the initial HTML is an empty `<div id="root">`. Astro solves this:

1. **Each tool page is pre-rendered as complete HTML at build time.** Google sees fully-formed content — headings, descriptions, FAQs, structured data — in the first response. No JavaScript needed to see content.
2. **React only loads for the interactive tool component** (the "island"). The marketing content around it (hero, how-to, FAQ, related tools) is pure static HTML — zero JS.
3. **View Transitions API** (native browser, supported in Astro) provides smooth page transitions without a full SPA router's JS overhead.
4. **Result:** Lighthouse 100 SEO, sub-1s LCP, minimal JS bundle, while keeping full React power for the actual tools.

### 3.4 Processing Architecture

All heavy processing runs in **Web Workers** to keep the UI thread free:

1. User drops/selects file(s) → main thread reads as `ArrayBuffer` via `FileReader`
2. `ArrayBuffer` is **transferred** (zero-copy via `Transferable`) to the appropriate Worker
3. Worker loads the WASM module and processes the file
4. Worker streams progress updates back to main thread (for progress bars)
5. Worker posts the result `ArrayBuffer` back
6. Main thread creates a `Blob` URL and triggers download or preview

**Critical constraints:**
- Files are held in browser memory. Target: reliable processing up to **200MB per file** and **500 pages per PDF**.
- For files >200MB, show a clear warning about memory pressure with suggestion to split the file first.
- Workers are pooled (2-4 workers depending on `navigator.hardwareConcurrency`) for parallel batch processing.

### 3.5 WASM Module Loading Strategy

WASM modules are large (MUPDF ~3MB gzipped, Sharp WASM ~2.5MB). Strategy:

| Trigger | Action |
|---|---|
| Landing page load | Load only shell + Astro + Tailwind. Zero WASM. |
| Tool card hover | `<link rel="prefetch">` for that tool's WASM chunk |
| Tool page navigation | Begin loading WASM in a Worker immediately |
| Repeat visit | Service Worker serves WASM from Cache API (instant) |

All WASM files are content-hashed and cached with `Cache-Control: immutable, max-age=31536000`. Second visits load from cache.

---

## 4. Frontend Stack & Design System

### 4.1 Design Philosophy

The site must feel like a **premium SaaS product**, not a developer's weekend project. Every interaction should feel intentional. The design language communicates: *"This tool is serious, trustworthy, and respects your time."*

**Anti-patterns to actively avoid:**
- Generic Bootstrap/Material UI look
- Cluttered sidebars or toolbars
- Aggressive CTAs or dark patterns
- Comic Sans-tier font choices
- Stock photos of people at laptops
- Skeleton screens that feel broken

### 4.2 Typography

| Role | Font | Weight | Size Range |
|---|---|---|---|
| Headings | **Inter** (variable) | 600-700 | 24-48px |
| Body | **Inter** (variable) | 400-500 | 14-18px |
| Monospace (technical) | **JetBrains Mono** | 400 | 13-14px |
| Signature fonts | Dancing Script, Caveat, Pacifico, Sacramento | 400 | 24-48px |

Inter is chosen for its excellent readability at all sizes, extensive character set, and native variable font support (no FOIT/FOUT issues).

### 4.3 Color System

```
Primary:       #1A56DB (trustworthy blue)
Primary Light: #3B82F6
Primary Dark:  #1E40AF
Background:    #FAFBFC (cool off-white)
Surface:       #FFFFFF
Border:        #E2E8F0
Text Primary:  #1E293B
Text Secondary:#64748B
Text Muted:    #94A3B8
Success:       #16A34A
Warning:       #EAB308
Error:         #DC2626
```

Dark mode (toggle in header):
```
Background:    #0F172A
Surface:       #1E293B
Border:        #334155
Text Primary:  #F1F5F9
Text Secondary:#94A3B8
```

### 4.4 Component Library (shadcn/ui customized)

All components from shadcn/ui, customized to the Docukit design language:

- **Buttons:** rounded-lg, subtle shadow, hover lift animation (translateY -1px + shadow increase), press feedback (scale 0.98). Primary blue, secondary ghost, destructive red.
- **Cards:** rounded-xl, subtle border, hover shadow elevation. Used for tool cards on homepage.
- **Modals/Dialogs:** centered overlay with backdrop blur (8px), Framer Motion scale-in animation.
- **Tooltips:** appear on hover after 300ms delay, fade in with slight translateY. Used everywhere for non-obvious controls.
- **Toasts:** bottom-right stacked notifications (Sonner library). Success/error/info variants. Auto-dismiss after 4 seconds.
- **Tabs:** underline style for tool sub-options (e.g., signature method: Draw | Type | Upload).
- **Sliders:** custom styled range inputs for quality, opacity, DPI settings. Value label appears on thumb while dragging.
- **Progress bars:** animated fill with percentage label. Striped animation while processing.
- **Drop zones:** large dashed-border areas with animated file icon. Highlight on drag-over with blue border pulse.

### 4.5 Layout System

```
┌─────────────────────────────────────────────────┐
│ HEADER: Logo | Tool Nav Dropdown | Dark Mode | GitHub │
├─────────────────────────────────────────────────┤
│ TRUST BANNER: 🔒 Your files never leave your   │
│ browser. [How it works →]                       │
├─────────────────────────────────────────────────┤
│                                                 │
│ HERO: H1 + Description + Trust Badge            │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │                                             │ │
│ │     DROP ZONE / TOOL AREA                   │ │
│ │     (React island — interactive)            │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ HOW IT WORKS: 3-step visual                     │
│                                                 │
│ FEATURES: Grid of capabilities                  │
│                                                 │
│ FAQ: Collapsible Q&As (JSON-LD)                 │
│                                                 │
│ RELATED TOOLS: Card grid (internal links)       │
│                                                 │
├─────────────────────────────────────────────────┤
│ FOOTER: Links | Privacy | GitHub | "Made with   │
│ ❤️ — Your files never leave your browser"       │
└─────────────────────────────────────────────────┘
```

**Responsive breakpoints:**
- Mobile: < 640px (single column, stacked controls)
- Tablet: 640-1024px (compact grid, side-by-side preview)
- Desktop: > 1024px (full layout with sidebars for advanced options)

### 4.6 Homepage Design

The homepage is the tool discovery hub. Layout:

1. **Hero Section:** Large headline ("Process PDFs & Images. Privately. Instantly."), subheading ("100% browser-based — your files never leave your device"), primary CTA ("Choose a Tool ↓"), and an animated illustration showing files being processed inside a browser window (Lottie animation).

2. **Tool Grid:** 2-column (mobile) / 3-column (tablet) / 4-column (desktop) card grid. Each card shows:
   - Tool icon (custom SVG, animated on hover via Framer Motion)
   - Tool name ("Merge PDF")
   - One-line description ("Combine multiple PDFs into one")
   - Hover effect: card lifts + icon animates + border highlights

3. **Trust Section:** Three columns: "No Uploads" (with animated lock icon), "No Accounts" (with animated user-free icon), "No Limits" (with animated infinity icon). Each with a short paragraph explanation.

4. **How It Works:** Animated 3-step diagram: Upload → Process (browser icon with gears) → Download. GSAP scroll-triggered reveal.

5. **Testimonial/Social Proof:** (Phase 2 — once real users exist)

6. **Footer:** Minimal, clean. Links to all tools, privacy policy, GitHub (if open source).

---

## 5. Animation & Interaction System

### 5.1 Animation Library Breakdown

| Library | Used For | Load Strategy |
|---|---|---|
| **Framer Motion 12** | Component mount/unmount, layout animations, drag, gestures, shared layout transitions | Bundled with React islands (tree-shaken) |
| **GSAP + ScrollTrigger** | Landing page scroll animations, parallax, reveal-on-scroll effects | Loaded only on homepage and marketing sections |
| **Lottie (lottie-light)** | Loading/processing animations, empty states, success celebrations | JSON animation files loaded on-demand |
| **View Transitions API** | Page-to-page transitions (Astro native) | Zero JS — browser-native, progressive enhancement |
| **CSS Animations** | Micro-interactions (hover, focus, skeleton loading) | Inline via Tailwind's `animate-*` classes |

### 5.2 Animation Inventory

#### Page-Level Transitions
- **Page navigation:** Astro View Transitions with crossfade (opacity 0→1, 200ms ease-out). Tool area morphs using `view-transition-name` so the drop zone appears to persist across pages.
- **Initial page load:** Hero text slides up (translateY 20px→0, opacity 0→1, staggered 100ms per line). Tool grid cards fade in with stagger (50ms per card).

#### Tool Interactions
- **File drop zone:**
  - Idle: dashed border with subtle pulse animation (border-color oscillation, 2s cycle)
  - Drag-over: border turns solid blue, zone scales up 1.02x, background tints blue-50, file icon bounces
  - File accepted: green checkmark Lottie animation (300ms), zone contracts to file list
  - File rejected: red shake animation (150ms, translateX ±5px), error toast
- **File list items:**
  - Enter: fade-in + slideY (100ms stagger per item)
  - Reorder (drag): picked-up item lifts with shadow + scale 1.05, other items animate to new positions (layout animation via Framer Motion)
  - Remove: item slides right + fades out (200ms), remaining items collapse up (layout animation)
- **Processing state:**
  - Lottie animation: custom gear/document processing animation (2-3 second loop)
  - Progress bar: animated stripe fill with percentage counter
  - Per-page progress: for multi-page operations, each page thumbnail gets a checkmark as it completes
- **Completion:**
  - Success: confetti burst (canvas-confetti, 500ms) + Lottie checkmark
  - Download button: pulse animation (scale 1.0→1.05→1.0, infinite, subtle)
  - Before/after stats: counter animation (numbers count up from 0 to final value, 800ms)

#### Micro-Interactions
- **Button hover:** translateY -1px + shadow elevation (100ms)
- **Button press:** scale 0.98 (50ms)
- **Toggle switches:** spring animation (Framer Motion spring config: stiffness 500, damping 30)
- **Slider drag:** value tooltip follows thumb with slight bounce
- **Tab switch:** underline slides to new tab position (shared layout animation)
- **Tooltip appear:** fade-in + translateY -4px (200ms, 300ms delay)
- **Modal open:** backdrop fade-in (150ms) + dialog scale from 0.95→1.0 + opacity (200ms spring)
- **Toast enter:** slide-in from right (300ms spring)
- **Skeleton loading:** shimmer gradient animation (1.5s linear infinite)

#### Scroll Animations (Homepage Only)
- **Trust section icons:** animate in from bottom as section enters viewport (GSAP ScrollTrigger, stagger 200ms)
- **How-it-works steps:** sequential reveal — step 1 appears, pause 200ms, connecting line draws, step 2 appears, etc.
- **Tool grid:** cards fade in with wave pattern (GSAP stagger with grid layout)
- **Stats/numbers:** count-up animation triggers when section scrolls into view

### 5.3 Loading States

Every async operation has a thoughtful loading state:

| State | Visual |
|---|---|
| WASM module loading | Skeleton of the tool area + "Loading tools..." text with spinner. Lottie animation of toolbox opening. |
| File reading | Inline progress bar on the drop zone. "Reading file..." |
| Processing | Full Lottie animation (custom per tool category). Progress bar with percentage + ETA. Cancel button. |
| PDF page rendering | Skeleton thumbnails (gray rectangles) that fill in one-by-one as pages render. |
| Download preparing | Spinner on the download button. "Preparing download..." |

### 5.4 Empty States

When no files are loaded, each tool shows:

- A relevant Lottie illustration (e.g., document floating into a merge icon)
- Clear instruction text ("Drop your PDF files here, or click to browse")
- Supported file types listed below ("Supports: .pdf, max 200MB")
- Keyboard shortcut hint ("Or press Ctrl+V to paste from clipboard")

### 5.5 `prefers-reduced-motion` Compliance

All animations respect `prefers-reduced-motion: reduce`:
- Disable all translate/scale/rotate animations
- Replace with instant opacity changes
- Remove parallax and scroll effects
- Keep functional animations (progress bars) but remove decorative ones
- Lottie animations replaced with static final-frame images

---

## 6. Feature Specifications

### 6.1 PDF Signing (Visual + Cryptographic)

#### 6.1.1 Visual Signature (Draw / Type / Upload)

**Signature Creation Methods:**

| Method | UX | Technical Detail |
|---|---|---|
| **Draw** | Canvas pad with mouse/touch/stylus. Undo, redo, clear buttons. | `signature_pad.js` with Bezier smoothing. Exports as PNG with transparent background. Canvas: 600×200px @2x for retina. Pressure-sensitive on Apple Pencil / Wacom. |
| **Type** | Text input rendered in handwriting font. Live preview. | 4 font options: Dancing Script, Caveat, Pacifico, Sacramento. Rendered to hidden canvas → PNG export. Font size auto-adjusts to fit. |
| **Upload** | Upload PNG/JPG/SVG. Auto background removal. | Image loaded to canvas. Luminance-threshold background removal (white→transparent). User adjustable threshold slider (0-255). |

**Placement Workflow:**

1. User uploads PDF → pages rendered via PDF.js as preview images (lazy-loaded, 2-page buffer)
2. User creates/selects signature. Saved in `sessionStorage` (base64 PNG) for reuse within session.
3. User clicks on any page → draggable, resizable overlay appears (Framer Motion drag + resize handles)
4. Overlay controls: position (drag), size (corner handles with aspect ratio lock), rotation (rotation handle), opacity (slider 10-100%)
5. Can place multiple signatures, text fields (date, name, initials), checkmarks on different pages
6. "Apply & Download" → `pdf-lib` embeds PNG into PDF at exact coordinates using `PDFPage.drawImage()`. Signature is flattened — cannot be moved after saving.

**Additional Tools in Signing Mode:**
- **Initials mode:** smaller canvas, stored separately from full signature
- **Date stamp:** auto-inserts current date. Format configurable: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, or custom
- **Text annotation:** arbitrary text, font size (8-72pt), color picker, font selection
- **Checkmark / X / Dot stamps:** for form filling
- **Multi-page batch:** place same signature at same position across all pages or selected range

#### 6.1.2 Cryptographic Digital Signature (PKCS#7)

This is a real, verifiable digital signature embedded in the PDF per ISO 32000 / PAdES standard.

**How It Works (Technical Deep-Dive):**

1. **Certificate Source — Two Options:**
   - **Option A: Self-Signed (Generate in Browser):** User clicks "Generate Certificate." `node-forge` creates an RSA 2048-bit key pair + self-signed X.509 v3 certificate in-browser. User enters: Common Name (their name), Organization (optional), Email. Certificate is valid for 1 year. Private key + cert exported as `.p12` (PKCS#12) for user to save and reuse. Everything happens client-side.
   - **Option B: Upload Existing Certificate:** User uploads their own `.pfx` / `.p12` file (from a CA like DigiCert, GlobalSign, or their organization's PKI). User enters the certificate password. `node-forge` parses the PKCS#12 container to extract the private key and certificate chain.

2. **Signing Process:**
   - `pdf-lib` prepares the PDF with a signature placeholder (a `ByteRange` annotation with empty signature value)
   - The PDF bytes (excluding the placeholder) are hashed using SHA-256
   - `node-forge` creates a PKCS#7 (CMS) `SignedData` structure containing: the hash, the signer's certificate, a timestamp, and the RSA signature of the hash using the private key
   - The PKCS#7 blob is embedded into the PDF's signature placeholder
   - The private key is **never stored** — it exists only in memory during signing and is garbage-collected after

3. **Verification:**
   - When opened in Adobe Acrobat/Reader, the signature panel shows:
     - **With CA-issued cert:** "Signed by [Name]. Signature is valid." (green checkmark)
     - **With self-signed cert:** "Signed by [Name]. The signer's identity has not been verified." (yellow warning) — but "The document has not been modified since this signature was applied" (integrity verified)
   - Docukit also includes an in-app signature verification tool (reads the PKCS#7 from an uploaded signed PDF and displays cert details + integrity status)

4. **Visible Signature + Digital Signature Combined:**
   - User can place a visual signature AND attach a cryptographic signature to it
   - The visual element is linked to the signature field in the PDF
   - Clicking the visual signature in Adobe Reader opens the signature properties panel

**UI Flow:**
- Signing mode shows a toggle: "Visual Only" | "Digital Signature"
- Digital Signature mode shows: certificate selector (generate new / upload existing), certificate details display (CN, issuer, expiry), password input for uploaded certs, visible signature placement (optional — digital signatures can be invisible)

**Edge Cases:**
- **Expired certificate:** warning shown, user can proceed (signature is still technically valid, just expired)
- **Multiple signatures:** supported — each signer adds their own PKCS#7 without invalidating previous signatures
- **Encrypted PDF:** decrypt first, then sign
- **Certificate download:** after generating self-signed cert, prominent "Download your certificate (.p12)" button with warning: "Save this file securely — you'll need it to sign future documents with the same identity"

---

### 6.2 Merge PDFs

**Core Workflow:**
1. User uploads 2+ PDFs via drop zone or file picker (multi-select)
2. Files appear in a sortable card list (dnd-kit):
   - Each card shows: filename, page count, file size, first-page thumbnail
   - Drag handle on left, remove button on right
   - Expand arrow to see all page thumbnails from that file
3. User reorders by dragging cards
4. "Merge & Download" button → `pdf-lib.copyPages()` concatenates in displayed order

**Advanced Options:**
- **Page selection per file:** expand a file card to see its page thumbnails; click to deselect specific pages. Syntax input: "1-5, 8, 12-last"
- **Insert blank page between documents:** toggle, with page size matching (auto-detects the largest page size in the merge set)
- **Append mode:** pick a "base" document, append others after it
- **Preserve bookmarks:** bookmarks/outlines from source PDFs are remapped to correct page numbers in merged output
- **Preserve hyperlinks:** internal links are adjusted for new page numbering

**Edge Cases:**
- Mixed page sizes: preserved as-is (each page keeps its original dimensions)
- Encrypted PDFs: prompt for password per file, decrypt before merge
- 50+ files: show memory estimate and warning if total exceeds ~150MB

---

### 6.3 Split PDF

**Split Modes:**

| Mode | Behavior | Output |
|---|---|---|
| Extract Pages | User specifies pages/ranges: "1,3,5-10,15-last" | Single PDF with selected pages |
| Split by Range | Multiple ranges: "1-5, 6-10, 11-20" | Multiple PDFs, one per range |
| Split Every N Pages | User enters N | Chunks of N pages each (last chunk may be smaller) |
| Extract Each Page | Every page → individual PDF | ZIP file containing all single-page PDFs |
| Remove Pages | User specifies pages to REMOVE | Single PDF with remaining pages |

**Page Selection UI:**
- Visual thumbnail grid of all pages (lazy-rendered, virtualized for large PDFs)
- Click to select/deselect (blue border = selected)
- Shift+click for range selection
- Ctrl/Cmd+click for individual toggle
- "Select All" / "Deselect All" / "Invert Selection" buttons
- Text input field supporting: `1-5, 8, 12-last`, `odd`, `even`, `first`, `last`
- Selected count shown: "8 of 24 pages selected"

---

### 6.4 Compress PDF

**Compression Levels:**

| Level | Strategy | Typical Reduction |
|---|---|---|
| Low (Lossless) | Remove duplicate objects, optimize object streams, strip metadata, linearize | 10-30% |
| Medium (Default) | Low + re-encode images at JPEG 80% quality, downscale images >150 DPI to 150 DPI | 40-70% |
| High | Medium + JPEG 60% quality, downscale to 100 DPI, convert PNG→JPEG where no alpha | 60-90% |
| Custom | User picks: DPI target, JPEG quality (1-100), grayscale toggle, strip fonts toggle | Variable |

**Implementation:** MUPDF WASM for full compression pipeline (image re-encoding, stream optimization, font subsetting). For simple metadata stripping, pdf-lib suffices. Workers extract embedded images, re-encode via Canvas `toBlob()` with quality parameter, and replace in PDF.

**UI Feedback:**
- Before/after file size shown prominently with percentage saved (counter animation)
- Side-by-side visual quality preview (split slider — drag to compare before/after on a sample page)
- Progress bar with per-page status for large PDFs
- "Estimated output size" updates in real-time as user adjusts quality slider

---

### 6.5 Organize & Rearrange PDF Pages

**UI:** Full-width thumbnail grid with controls.

**Capabilities:**
- **Drag and drop reorder** (dnd-kit): grab thumbnail, drop at new position. Visual drop indicator (blue line between pages). Framer Motion layout animation for smooth repositioning.
- **Multi-select:** Ctrl/Cmd+click or shift+click to select multiple pages. Drag the group.
- **Rotate:** 90° CW/CCW buttons on each thumbnail hover overlay. Also applies to selected batch.
- **Delete:** X button on hover. Ctrl+Z undo support (keep deleted pages in memory for undo stack, up to 20 actions).
- **Insert blank page:** "+" button between thumbnails.
- **Duplicate page:** right-click context menu or dedicated button.
- **Zoom control:** thumbnail size slider (small 80px / medium 150px / large 250px).
- **Page labels** update in real-time during reorder.

**Technical:** PDF.js renders thumbnails to OffscreenCanvas in workers. Reorder creates new PDF via pdf-lib `copyPages()` in new order. Rotation via `setRotation()`.

---

### 6.6 Password Protect & Unlock PDF

#### Add Password (Encrypt)

- **User password:** required to open the PDF
- **Owner password (optional):** controls permissions
- **Permission checkboxes:** Print, Copy Text, Edit Content, Fill Forms, Add Annotations, Assemble Document
- **Encryption standard:** AES-256 (PDF 2.0) via pdf-lib's `encrypt()` method
- **Password strength meter:** real-time visual feedback (weak/medium/strong) using zxcvbn algorithm
- **Confirm password field** with match validation
- **Generate random password** button with copy-to-clipboard

#### Remove Password (Decrypt)

- Upload encrypted PDF → app detects encryption immediately
- Password prompt with "Show password" toggle
- On correct password: pdf-lib decrypts → user downloads unprotected version
- On wrong password: clear error message with retry. No brute-force possible (processing is local; no rate limiting needed since there's no server to attack, but user would need to manually retry)
- Shows encryption details: algorithm used, permissions set by original encryptor

---

### 6.7 PDF ↔ Image Conversion

#### PDF to Image

- Each page rendered via PDF.js
- **Output formats:** PNG, JPEG (quality slider 1-100), WebP (quality slider), AVIF
- **DPI selector:** 72 (screen), 150 (print), 300 (high-quality), custom (up to 600)
- **Single page / all pages / page range**
- Multi-page output: ZIP file download
- **Preview:** rendered pages shown in a scrollable list before download

#### Image to PDF

- Upload one or more images (PNG, JPEG, WebP, BMP, TIFF, SVG, HEIC)
- Reorderable via drag-and-drop
- **Page size options:** Fit Image (page = image dimensions), A4, Letter, Legal, custom dimensions
- **Image placement:** Center with margins, Stretch to fill, Fit within page (maintain aspect ratio)
- **Margin controls:** Top, Right, Bottom, Left in mm or inches
- **Background color:** white (default) or custom
- **Per-image or global settings**

---

### 6.8 Watermarks (PDF & Images)

**Watermark Types:**

| Type | Options |
|---|---|
| Text Watermark | Custom text, font family (6 options), font size (12-120pt), color + opacity slider, rotation (-90° to 90°, default -45°), single placement or tiled/repeated grid |
| Image Watermark | Upload logo/image, resize handles, position (center/corners/tile), opacity slider (5-100%) |

**PDF-Specific:**
- Apply to: all pages / specific pages / odd only / even only
- Layer: behind content (default) or on top
- Live preview on a sample page (updates as settings change)
- Implementation: `pdf-lib` `drawText()` or `drawImage()` with opacity per target page

**Image-Specific:**
- Same controls but applied via Canvas API
- Batch mode: same watermark across multiple images
- Output preserves original format and dimensions

---

### 6.9 Edit PDFs & Images (Annotation Layer)

**This is an overlay/annotation editor, not a full PDF text editor** (re-parsing PDF content streams is infeasible client-side for arbitrary PDFs).

**Annotation Tools:**

| Tool | Description |
|---|---|
| **Text box** | Click to place, type content. Font family (6 options), size (8-72pt), color, bold/italic/underline. Draggable + resizable. |
| **Image overlay** | Upload and place image. Draggable, resizable, rotatable. |
| **Emoji picker** | Standard emoji palette (Emoji Mart component). Click to place, resize. Rendered as high-res PNG for cross-platform consistency. |
| **Shapes** | Rectangle, circle/ellipse, line, arrow. Stroke color, fill color with opacity, stroke width (1-10px). |
| **Freehand draw** | Pen tool with color, width (1-20px), opacity. Canvas path recording with Bezier smoothing. |
| **Highlight** | Semi-transparent rectangle in yellow/green/blue/pink for highlighting text regions. |
| **Whiteout** | Opaque white/black rectangle to cover content. (See section 6.12 for proper redaction.) |
| **Stamp** | Predefined stamps: "APPROVED", "DRAFT", "CONFIDENTIAL", "COPY", "VOID" with customizable color/size. |

**Editor Architecture:**
- PDF pages rendered via PDF.js as background images in a scrollable viewport
- Fabric.js canvas overlay on each visible page for annotations
- Toolbar docked at top (desktop) or bottom sheet (mobile)
- Undo/redo stack (Ctrl+Z / Ctrl+Shift+Z, up to 50 actions)
- Zoom: pinch-to-zoom on mobile, scroll-wheel on desktop, zoom slider control

**Save Options:**
- **Flatten (default):** annotations permanently composited into PDF via `pdf-lib` vector operations (text as drawText, images as drawImage, shapes as drawLine/drawRectangle) — maintains vector quality
- **Keep as annotations:** PDF annotation objects (viewable/editable in Adobe Reader)

---

### 6.10 Add Page Numbers to PDF

**Configuration:**

| Setting | Options |
|---|---|
| Position | bottom-center (default), bottom-left, bottom-right, top-center, top-left, top-right |
| Format | "1", "Page 1", "Page 1 of N", "1/N", Roman (i, ii, iii), Alphabetic (a, b, c) |
| Starting number | User-configurable (default: 1) |
| Page range | All pages, or subset (e.g., "skip first 2 pages" for cover + TOC) |
| Font | Arial, Times New Roman, Courier, Helvetica |
| Font size | 8-16pt (default: 10pt) |
| Color | Color picker (default: #333333) |
| Margin from edge | mm input (default: 15mm from bottom, 20mm from side) |

**Implementation:** `pdf-lib` `drawText()` on each page. Coordinates calculated from page dimensions + selected position + margin offset. Handles mixed page sizes correctly (recalculates per page).

**Live preview:** shows the first and last page with numbers applied.

---

### 6.11 Crop PDF

**Crop Modes:**
- **Visual crop:** drag a crop rectangle on page preview (handles on corners + edges). Aspect ratio lock toggle. Precise pixel coordinates shown while dragging.
- **Numeric input:** enter crop margins (top, right, bottom, left) in mm, inches, or points
- **Auto-crop whitespace:** detect white borders and remove them automatically (luminance scan from edges inward)
- **Apply to:** current page only / all pages (same crop) / custom per-page

**Implementation:**
- **Option A (default): Modify CropBox.** Fast, lossless, reversible (content outside crop still exists in PDF, just hidden). Via `pdf-lib` `page.setCropBox()`.
- **Option B (Flatten): Re-render and re-create page.** Irreversible, removes content outside crop, smaller file. Via MUPDF WASM.
- User chooses which option via a toggle: "Keep hidden content" (CropBox) vs "Permanently remove" (Flatten).

---

### 6.12 Redact PDF & Image Data

**⚠️ Security-Critical Feature.** Merely covering text with a black box is NOT redaction — text can still be selected and copied underneath. True redaction must **destroy** the underlying data.

#### PDF Redaction Workflow

1. User opens PDF in the annotation editor
2. Selects the **Redact tool** (distinct red-bordered tool, visually separated from other tools)
3. Draws rectangles over sensitive areas → marked in translucent red with "REDACT" label (preview mode — content still visible underneath)
4. Can also use "Find & Redact": search for text (SSN patterns, names, emails) → all instances highlighted for redaction
5. Clicks **"Apply Redactions"** → **confirmation dialog** with explicit warning:
   > ⚠️ **This action is irreversible.** All content under the marked areas will be permanently destroyed. Text, images, and metadata in those regions will be completely removed from the file. This cannot be undone.
   >
   > [Cancel] [Apply Redactions]
6. MUPDF WASM processes the PDF:
   - Removes all text characters within redaction bounds from the content stream
   - Removes all image fragments within redaction bounds
   - Draws solid rectangle (black or user-chosen color) in place
   - Removes hidden metadata, bookmarks, and links in redacted areas
   - Removes XMP metadata, document info dict, and embedded file attachments if user selects "Full metadata strip"
7. Output PDF: redacted content is genuinely gone from the file bytes

#### Image Redaction

Simpler: user draws rectangles → on save, those pixel regions are overwritten with solid color using Canvas API's `fillRect()` → image re-encoded. Original pixel data is destroyed.

#### Safety Measures
- Two-step process: mark, then apply. Never auto-apply.
- Redact tool is visually distinct (red border, warning icon) from the whiteout/shape tools
- "Apply Redactions" button is red with warning icon
- Post-redaction verification: tool offers to re-extract text from the output PDF and search for redacted terms to confirm removal
- SHA-256 hash of before/after shown to prove file changed

---

### 6.13 PDF Contextual Search

**Search Engine:** Fuse.js running entirely client-side.

**Indexing:**
- On PDF load, PDF.js extracts text from all pages in a Worker
- Text is chunked per-page with metadata: `{ pageNumber, text, bbox (bounding boxes per word) }`
- Fuse.js index created with keys: `text`, weighted towards exact matches

**Search Features:**
- Fuzzy matching with configurable threshold (strict ↔ loose slider)
- Results show: page number, highlighted matching text, ±50 chars context
- Click result → scroll to page and highlight match with animated yellow flash
- Search stats: "N results across M pages"
- Filters: case-sensitive toggle, whole-word toggle, regex mode
- Keyboard shortcut: Ctrl/Cmd+F opens search bar (intercepted before browser's native find)
- Debounced input (300ms) to avoid jank on large documents

**Performance:** Text extraction: ~1 second for 100 pages. Fuse.js search: <50ms for <500 pages. For 500+ pages, show "Indexing..." progress, then search is still fast.

---

### 6.14 Image Processing Suite

#### 6.14.1 Compress Image

- **Input:** JPEG, PNG, WebP, BMP, TIFF, AVIF, HEIC
- **Compression modes:**
  - Quality slider (1-100) for lossy formats
  - **Target file size:** user enters "< 500KB" → iterative binary-search on quality to hit target (max 10 iterations)
  - Percentage reduction: "Reduce by 50%"
- **Output format:** keep original, or convert to JPEG/WebP/PNG/AVIF
- **Before/after comparison:** split-view slider overlay (drag divider left/right)
- **Batch mode:** upload multiple, apply same settings, download as ZIP
- **Smart compression:** detect image content type (photo vs illustration vs text) and adjust strategy (JPEG for photos, PNG for sharp edges/text, WebP for either)
- **EXIF strip option:** remove all metadata (location, camera info) — important for privacy

#### 6.14.2 Resize Image

- **Resize by:** exact dimensions (W×H px), percentage, or one dimension + aspect ratio lock
- **Aspect ratio:** locked by default, toggle to unlock
- **Preset sizes:** social media templates in a searchable dropdown:
  - Instagram: Post (1080×1080), Story (1080×1920), Landscape (1080×566)
  - Twitter/X: Post (1200×675), Header (1500×500)
  - LinkedIn: Banner (1584×396), Post (1200×627)
  - YouTube: Thumbnail (1280×720), Banner (2560×1440)
  - Facebook: Cover (820×312), Post (1200×630)
  - Custom presets: user can save their own (stored in localStorage)
- **Fit modes:** Fit (letterbox/pillarbox), Fill (crop), Stretch (distort), Cover (smart crop)
- **Upscale warning:** if target > original, yellow warning: "Upscaling may reduce quality"
- **DPI/PPI setting** for print targets
- **Batch mode**

#### 6.14.3 Lock Image with Password

Encrypts an image into a self-contained HTML file:

1. User uploads image + sets password
2. Web Crypto API: PBKDF2 (100,000 iterations, SHA-256) derives AES-256-GCM key from password
3. Image ArrayBuffer encrypted with `crypto.subtle.encrypt()`
4. App generates a **standalone HTML file** containing:
   - Encrypted data (base64)
   - Minimal, styled password input (dark theme, centered, Docukit branding)
   - Decryption JavaScript (Web Crypto API — no dependencies)
   - Meta viewport tag (mobile-friendly)
5. HTML file is self-contained. Open in any modern browser → password prompt → correct password → image displayed
6. Wrong password → "Incorrect password" error (AES-GCM authentication tag fails)

**Security:** AES-256-GCM is authenticated encryption. PBKDF2 with 100K iterations makes brute force expensive. No server involved. User downloads the HTML and shares it however they want (email, drive, USB).

#### 6.14.4 View-Once Image Link (Only Backend Feature)

**Architecture:** Cloudflare Worker + KV. This is the ONLY feature requiring server-side code.

**Flow:**
1. User uploads image in browser
2. Client generates random 256-bit AES key
3. Image encrypted client-side (AES-256-GCM) using Web Crypto API
4. Encrypted blob → `POST /api/view-once` → stored in Cloudflare KV with:
   - Unique ID (UUID v4)
   - TTL: user-selected (1h / 6h / 24h / 7d, default 24h)
   - Max size: 10MB
5. App generates URL: `docukit.uk/view/[id]#[key]`
   - The `#[key]` fragment is **never sent to the server** per HTTP spec — it stays in the browser
6. Recipient opens URL → Worker serves encrypted blob from KV → **immediately deletes KV entry**
7. Client-side JS reads key from URL hash → decrypts → displays image
8. Refresh → "This image has expired or already been viewed."

**Privacy guarantee:** The server only ever holds encrypted ciphertext. The key never touches the network. Even Cloudflare cannot view the image.

**Rate limits:** 10 creates/min/IP, 60 reads/min/IP. Enforced by Cloudflare's built-in rate limiting.

#### 6.14.5 Image Format Conversion

- Convert between: JPEG, PNG, WebP, BMP, TIFF, AVIF, ICO, GIF, SVG (rasterize)
- Batch conversion to single target format
- Per-format quality settings
- HEIC → JPEG/PNG for iPhone photo compatibility

#### 6.14.6 Image Crop & Rotate

- **Crop:** freeform or aspect ratio presets (16:9, 4:3, 1:1, 3:2, 9:16, custom)
- **Rotate:** 90° CW/CCW, 180°, freeform angle input with grid overlay
- **Flip:** horizontal / vertical
- **Straighten:** ±15° fine rotation with horizon grid

---

## 7. SEO Strategy

### 7.1 URL Architecture

Every tool gets a dedicated, pre-rendered page targeting specific keyword clusters.

| URL Path | Primary Keyword | Est. Monthly Search Volume |
|---|---|---|
| `/sign-pdf` | sign pdf online free | 90,000+ |
| `/digital-signature-pdf` | digital signature pdf | 60,000+ |
| `/merge-pdf` | merge pdf | 550,000+ |
| `/split-pdf` | split pdf | 200,000+ |
| `/compress-pdf` | compress pdf | 450,000+ |
| `/rearrange-pdf-pages` | rearrange pdf pages | 40,000+ |
| `/protect-pdf` | password protect pdf | 60,000+ |
| `/unlock-pdf` | unlock pdf | 80,000+ |
| `/pdf-to-image` | pdf to jpg | 300,000+ |
| `/image-to-pdf` | image to pdf | 250,000+ |
| `/watermark-pdf` | add watermark to pdf | 30,000+ |
| `/edit-pdf` | edit pdf online free | 200,000+ |
| `/add-page-numbers` | add page numbers to pdf | 25,000+ |
| `/crop-pdf` | crop pdf | 35,000+ |
| `/redact-pdf` | redact pdf | 15,000+ |
| `/compress-image` | compress image online | 200,000+ |
| `/resize-image` | resize image | 350,000+ |
| `/convert-image` | convert image format | 100,000+ |
| `/lock-image` | encrypt image with password | 5,000+ |

### 7.2 Pre-Rendering Strategy (Astro SSG)

Astro generates complete HTML at build time. Each tool page's HTML contains:
- Full semantic content (H1, description, how-to steps, features, FAQ) — visible to Googlebot without JS
- The React tool component loads as an interactive island after hydration
- Result: Google indexes rich content immediately; users get interactive tools after minimal JS load

### 7.3 On-Page SEO (Per Tool Page)

| Element | Specification |
|---|---|
| **Title tag** | `[Action] PDF Online Free — No Upload \| Docukit` (under 60 chars) |
| **Meta description** | `[Action] your PDF files online for free. 100% browser-based — no uploads, no sign-up. Private and secure.` (under 160 chars) |
| **H1** | One per page, matches primary keyword. e.g., "Merge PDF Files Online for Free" |
| **H2 sections** | "How to [Action] PDF", "Features", "Why Docukit?", "Frequently Asked Questions" |
| **JSON-LD: SoftwareApplication** | name, description, applicationCategory ("Utility"), operatingSystem ("Web"), offers (Free), aggregateRating (Phase 2) |
| **JSON-LD: FAQPage** | 4-6 Q&As per tool targeting long-tail queries |
| **JSON-LD: BreadcrumbList** | Home > PDF Tools > Merge PDF |
| **JSON-LD: HowTo** | 3-step how-to schema matching the visual how-to section |
| **Open Graph** | Tool-specific OG image (auto-generated at build), title, description, type: website |
| **Twitter Card** | summary_large_image with tool-specific graphic |
| **Canonical URL** | Self-referencing on each page |
| **Alt text** | On all images, thumbnails, icons |

### 7.4 Technical SEO

- `robots.txt`: allow all tool pages, block `/assets/`, WASM files, source maps
- `sitemap.xml`: auto-generated by Astro at build time. Submitted to Google Search Console.
- **Page speed:** target Lighthouse 95+ on all metrics. Cloudflare CDN + Brotli + code splitting.
- **Core Web Vitals targets:** LCP < 1.5s, CLS < 0.05 (min-height on tool area prevents shifts), INP < 100ms (WASM loads post-interaction)
- **Internal linking:** every tool page includes a "Related Tools" card grid (3-4 related tools). Footer links to all tools.
- **301 redirects:** via Cloudflare Pages `_redirects` file
- **HTTPS:** enforced by Cloudflare (HSTS enabled)
- **Mobile-friendly:** responsive design passes Google Mobile-Friendly Test
- **Structured data testing:** validated via Google Rich Results Test before launch

### 7.5 Content Strategy

**Phase 1 (Launch):**
- Each tool page includes: 3-step "How to" section, 4-6 FAQ entries, feature list, "Why Docukit?" trust section — all pre-rendered in HTML for SEO

**Phase 2 (Growth):**
- `/blog` with SEO-targeted articles: "How to Compress a PDF Without Losing Quality", "Best Free PDF Merger 2026", "How to Digitally Sign a PDF for Free"
- Comparison pages: "Docukit vs Smallpdf", "Docukit vs ILovePDF"
- Use-case landing pages: "Sign a Lease Agreement Online", "Compress Images for Email", "Redact Sensitive Data from Legal Documents"
- Multilingual: i18n for top 5 languages by search volume (Spanish, Portuguese, French, German, Hindi)

### 7.6 Link Building Strategy

- Submit to Product Hunt, Hacker News, Reddit (/r/webdev, /r/SideProject, /r/selfhosted)
- Dev community: write technical blog posts about client-side WASM PDF processing
- Open-source the project (Phase 2): GitHub stars drive organic backlinks
- Answer PDF-related questions on Stack Overflow / Quora with links to relevant tool pages

---

## 8. Security Hardening

### 8.1 Content Security Policy (CSP)

Deployed via Cloudflare Pages `_headers` file:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self';
  worker-src 'self' blob:;
  connect-src 'self';
  wasm-src 'self';
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
```

**Key point:** `connect-src 'self'` blocks ALL fetch/XHR to external origins. This is the **strongest technical proof** that files cannot be exfiltrated. Users can verify this in DevTools → Network tab.

### 8.2 Additional Headers

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

COOP/COEP headers enable `SharedArrayBuffer` for WASM multi-threading (needed by MUPDF for performance).

### 8.3 Subresource Integrity (SRI)

All JS/CSS bundles served with `integrity` attributes. Vite's build pipeline generates SRI hashes automatically. If a CDN-served file is tampered with, the browser refuses to load it.

### 8.4 Client-Side Security Model

- **No network requests with file data.** Verified by CSP.
- **Processing in sandboxed Web Workers** — no DOM access, no `importScripts` to external origins.
- **Files in memory only** — `ArrayBuffer` / `Blob`. Explicitly revoked via `URL.revokeObjectURL()` after download.
- **No localStorage for file content.** Session state (undo history) uses in-memory Zustand stores that die with the tab.
- **No cookies.** No session tokens. No user accounts.
- **Private keys (for PDF signing) exist only in memory** during the signing operation. Never serialized to storage unless user explicitly exports the .p12 file.

### 8.5 Anti-Tampering

The static site is immutable on Cloudflare's CDN. There's no server to compromise. The WASM binaries are hash-verified via SRI. An attacker cannot inject code without compromising:
1. The GitHub repo (requires push access + branch protection bypass), AND
2. The Cloudflare Pages deployment pipeline

This is a significantly higher bar than compromising a typical backend server.

### 8.6 View-Once Worker Security

- Rate-limited: 10 creates/min/IP, 60 reads/min/IP
- KV TTL: max 7 days, auto-expire even if never viewed
- Max upload: 10MB
- No open redirects or user-generated URLs
- Input validation: only accept valid encrypted blob payloads
- CORS: only accept requests from `docukit.uk` origin

### 8.7 Dependency Security

- `npm audit` in CI/CD — block deploys on critical vulnerabilities
- Dependabot / Renovate for automated dependency updates
- Pin WASM binary versions; verify checksums in build script
- Minimal dependency count — prefer native browser APIs (Web Crypto, Canvas, FileReader) over libraries

---

## 9. Performance Requirements

| Metric | Target | Measurement |
|---|---|---|
| Time to Interactive (TTI) | < 2.0 seconds | Lighthouse, 4G throttle |
| Largest Contentful Paint (LCP) | < 1.5 seconds | Core Web Vitals |
| Cumulative Layout Shift (CLS) | < 0.05 | Core Web Vitals |
| Interaction to Next Paint (INP) | < 100ms | Core Web Vitals |
| WASM cold load | < 3 seconds on 3G | Network tab |
| PDF merge (10 files, 50 pages) | < 5 seconds | In-app timing |
| Image compression (5MB JPEG) | < 2 seconds | In-app timing |
| Initial JS bundle (before WASM) | < 100KB gzipped | Vite build output |
| Lighthouse Performance | ≥ 95 | Lighthouse CI |
| Lighthouse SEO | 100 | Lighthouse CI |
| Lighthouse Accessibility | ≥ 95 | Lighthouse CI |

### 9.1 Optimization Strategies

- **Astro island architecture:** only interactive tool components ship JS. Marketing/SEO content is pure HTML.
- **Route-based code splitting:** each tool page loads only its dependencies.
- **WASM lazy load + prefetch-on-hover** (section 3.5).
- **Service Worker:** Cache API caches all static assets for offline/instant revisit. Cache-first for assets, network-first for HTML.
- **Brotli compression:** served by default on Cloudflare Pages.
- **Image thumbnails:** rendered in OffscreenCanvas workers to avoid main-thread jank.
- **Progressive processing:** for multi-page operations, show per-page progress instead of single spinner.
- **Worker pooling:** 2-4 workers based on `navigator.hardwareConcurrency` for parallel batch processing.
- **Memory management:** explicitly release ArrayBuffers after processing, force GC-eligible by nulling references.

---

## 10. Accessibility

- **WCAG 2.1 AA compliance** across all tool pages
- All interactive elements keyboard-navigable (tab order, Enter/Space activation)
- **ARIA labels:** drop zones ("File upload area, accepts PDF files"), tool buttons, page thumbnails ("Page 3 of 12"), progress indicators ("Compressing, 60% complete")
- **Drag-and-drop alternatives:** arrow keys to reorder, or explicit "Move Up / Move Down" buttons for keyboard users
- **Color contrast:** 4.5:1 minimum for text, 3:1 for interactive elements (verified by axe-core in CI)
- **Focus rings:** visible custom focus indicators (2px blue outline, 2px offset) on all interactive elements
- **`prefers-reduced-motion`:** all animations disabled/simplified (section 5.5)
- **`prefers-color-scheme`:** dark mode auto-detected (also manual toggle)
- **Screen reader announcements:** `aria-live="polite"` regions for status updates
- **Form validation:** inline errors linked via `aria-describedby`
- **Skip navigation link:** "Skip to tool" link visible on focus
- **Touch targets:** minimum 44×44px on mobile

---

## 11. Deployment & Infrastructure

### 11.1 Cloudflare Pages Setup

| Setting | Value |
|---|---|
| Git provider | GitHub |
| Branch | `main` |
| Build command | `npm run build` (Astro build) |
| Output directory | `dist/` |
| Node.js version | 20.x |
| Auto-deploy | On push to `main` |
| Preview deploys | On every PR (auto-deleted after merge) |
| Custom domain | docukit.uk |
| SSL | Full (strict), auto-provisioned by Cloudflare |
| HSTS | Enabled, max-age 1 year |

### 11.2 Cloudflare Worker (View-Once Only)

- Single Worker script in `/worker/` directory
- Routes: `POST /api/view-once`, `GET /api/view-once/:id`
- KV namespace: `VIEW_ONCE_STORE`
- Rate limiting via Cloudflare Rules
- Deployed via `wrangler` in the same CI pipeline

### 11.3 Caching Strategy

| Asset | Cache Duration | Strategy |
|---|---|---|
| HTML pages | 10 minutes | Stale-while-revalidate |
| JS/CSS (hashed) | 1 year | Immutable, cache-first |
| WASM (hashed) | 1 year | Immutable, cache-first |
| Fonts | 1 year | Immutable |
| OG images | 1 week | Stale-while-revalidate |
| Service Worker | No cache | Network-first |

### 11.4 CI/CD Pipeline (GitHub Actions)

1. **Lint:** ESLint + Prettier check
2. **Type check:** TypeScript strict mode
3. **Unit tests:** Vitest (utility functions, WASM wrapper logic)
4. **A11y tests:** axe-core automated checks on rendered tool pages
5. **Build:** Astro build (SSG)
6. **Lighthouse CI:** run Lighthouse on preview deploy, fail if Performance < 90 or SEO < 95
7. **npm audit:** fail on critical vulnerabilities
8. **Deploy:** Cloudflare Pages auto-deploys on successful `main` push

### 11.5 Monitoring

- **Cloudflare Web Analytics:** page views, visitors, referrers, countries, devices (cookie-free)
- **Cloudflare Speed:** Core Web Vitals real-user monitoring
- **Custom telemetry:** anonymous tool usage events (tool name, processing time, file size bucket, success/failure) sent as `navigator.sendBeacon()` to a Cloudflare Worker that aggregates into D1/KV. No PII. No file content.
- **Error tracking:** client-side error boundary catches + reports to the same telemetry Worker
- **Uptime:** Cloudflare Pages 99.99% SLA; Uptime Robot as external check

---

## 12. Monetization (Phase 2)

Phase 1 is 100% free, no ads. Monetization deferred until organic traffic is established.

### Options:

| Stream | Price | What User Gets |
|---|---|---|
| **Docukit Pro** | $4.99/mo or $39.99/yr | Batch processing (unlimited parallel), priority WASM pre-caching, saved watermark/signature templates (synced via Cloudflare D1), 50MB view-once limit (vs 10MB free), remove "Powered by Docukit" from generated HTML files |
| **Ethical Ads** | — | Carbon Ads or EthicalAds. Single sidebar placement, never overlaying the tool. Non-tracking. |
| **API Access** | Usage-based ($0.01/op) | Cloudflare Worker API running the same WASM processing server-side for developer integration |

**Commitment:** Never add usage caps to free tier. Never require sign-up for core tools. Never dark-pattern users into Pro.

---

## 13. Development Roadmap

### Phase 1: Core Platform (Weeks 1–8)

| Week | Deliverable | Details |
|---|---|---|
| 1 | Project setup + Design system | Astro 5 + React 19 + Tailwind 4 + shadcn/ui. Layout shell, routing, homepage with animations (Framer Motion + GSAP). Design tokens, component library. |
| 2 | Merge + Split PDF | pdf-lib integration, dnd-kit file list, page selection grid UI, ZIP output for split. |
| 3 | Compress PDF + Organize Pages | MUPDF WASM integration, compression levels, quality preview. Thumbnail grid with drag-and-drop reorder. |
| 4 | Sign PDF (Visual + Cryptographic) | signature_pad.js, placement overlay, pdf-lib embedding. node-forge X.509 cert generation, @signpdf integration, .p12 export/import. |
| 5 | Password + Watermark + Crop + Redact | pdf-lib encrypt/decrypt, zxcvbn strength meter. Canvas watermark. CropBox + flatten crop. MUPDF true redaction with verification. |
| 6 | PDF ↔ Image + Search + Page Numbers | PDF.js rendering, Canvas image→PDF, format options. Fuse.js indexing + search UI. Page number configuration. |
| 7 | Image Tools Suite | Sharp WASM: compress, resize, format convert, crop/rotate. Web Crypto: lock-image HTML generator. Cloudflare Worker: view-once. |
| 8 | Edit/Annotate + SEO + Polish + Launch | Fabric.js annotation editor. JSON-LD structured data on all pages. OG images. Full QA pass. Lighthouse audit. Launch. |

### Phase 2: Growth (Weeks 9–16)
- Blog with SEO content
- Multilingual (i18n: Spanish, Portuguese, French, German, Hindi)
- PWA: installable, offline-capable
- Browser extension (Chrome/Firefox)
- Docukit Pro subscription
- Comparison/use-case landing pages
- Open-source the core library

### Phase 3: Platform (Weeks 17+)
- API for developers
- Template library (invoices, certificates, resumes)
- OCR for scanned PDFs (Tesseract.js WASM)
- PDF form filling
- Bulk processing dashboard
- E2E encrypted document sharing (beyond just images)

---

## 14. Risk Register

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| WASM modules too large for slow connections | High | Medium | Lazy load + prefetch + Service Worker cache + Brotli |
| Browser memory limits on large files | Medium | Medium | Streaming API where possible. Warn at 200MB. Suggest splitting. |
| SEO competition from Smallpdf/ILovePDF | High | High | Differentiate on privacy + no caps. Long-tail keywords. Content strategy. |
| Safari WASM/SharedArrayBuffer issues | Medium | Low | Test Safari regularly. Polyfills. Graceful degradation. |
| Cloudflare KV abuse (view-once) | Low | Medium | Rate limits, TTL, size caps, monitoring. |
| Incorrect PDF redaction | Critical | Low | MUPDF proven redaction. Automated test suite verifying text removal. Two-step UX. |
| node-forge crypto bugs | High | Low | Pin version. Use Web Crypto API for all symmetric ops. forge only for X.509/PKCS7. |
| PDF signing incompatibility with readers | Medium | Medium | Test across Adobe Reader, Preview, Chrome, Firefox, Foxit. Document known limitations. |
| User loses self-signed certificate | Low | High | Prominent "Download your .p12" prompt. Warning text. Option to regenerate. |

---

## 15. Appendix

### 15.1 Library Reference

| Library | Size (gzip) | Purpose |
|---|---|---|
| pdf-lib | ~250KB | PDF creation, editing, signing, encryption |
| PDF.js | ~400KB | PDF rendering, text extraction |
| MUPDF WASM | ~3MB | Compression, redaction, heavy processing |
| node-forge | ~200KB | X.509 certs, PKCS#7, PKCS#12, RSA |
| @signpdf/signpdf | ~50KB | PDF digital signature embedding |
| signature_pad | ~10KB | Drawing signatures |
| Fuse.js | ~6KB | Fuzzy search |
| dnd-kit | ~15KB | Drag and drop |
| Fabric.js | ~100KB | Canvas annotation editor |
| Framer Motion | ~30KB | Component animations |
| GSAP + ScrollTrigger | ~25KB | Scroll animations (homepage only) |
| lottie-light | ~15KB | JSON animations |
| Zustand | ~2KB | State management |
| JSZip | ~25KB | ZIP creation for multi-file downloads |
| Sonner | ~5KB | Toast notifications |
| canvas-confetti | ~5KB | Success celebration effect |

### 15.2 Browser Support

| Browser | Min Version | Notes |
|---|---|---|
| Chrome / Edge | 90+ | Full support |
| Firefox | 90+ | Full support |
| Safari / iOS | 15.4+ | SharedArrayBuffer requires COOP/COEP headers (configured) |
| Samsung Internet | 15+ | Chromium-based, follows Chrome |

### 15.3 Glossary

| Term | Definition |
|---|---|
| **WASM** | WebAssembly — binary instruction format for near-native speed in browsers |
| **CSP** | Content Security Policy — HTTP header restricting what resources a page can load |
| **SRI** | Subresource Integrity — verifies fetched resources match expected cryptographic hash |
| **PKCS#7 / CMS** | Cryptographic Message Syntax — standard for signed/encrypted data, used in PDF digital signatures |
| **PKCS#12 / .p12 / .pfx** | Container format for private key + certificate bundle, password-protected |
| **X.509** | Standard for public key certificates used in PKI |
| **PAdES** | PDF Advanced Electronic Signatures — EU standard for PDF digital signatures |
| **AES-256-GCM** | Authenticated encryption algorithm providing confidentiality + integrity |
| **PBKDF2** | Password-Based Key Derivation Function — converts password to crypto key with configurable cost |
| **CropBox** | PDF page boundary defining the visible display/print area |
| **KV** | Cloudflare Key-Value store — globally distributed, eventually consistent |
| **SSG** | Static Site Generation — pre-rendering HTML at build time |
| **Island Architecture** | Ship static HTML by default; hydrate only interactive components ("islands") with JS |

---

*End of Document*
