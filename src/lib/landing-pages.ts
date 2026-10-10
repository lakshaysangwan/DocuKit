import { getToolBySlug, type ToolDef } from './tools-registry';

/**
 * Task-specific landing pages.
 *
 * Each one is an existing tool opened with a preset, under the name people
 * actually search for ("rotate pdf", "png to jpg") — not a new capability. They
 * live outside TOOLS so the homepage grid, header menus and the Phase 7 parity
 * gate keep describing the real tools.
 *
 * Two rules, both enforced by landing-pages.test.ts:
 *   • `features` may only repeat bullets the base tool already advertises, so a
 *     landing page can never promise more than the tool the parity gate covers.
 *   • The copy never uses the word "free".
 */
export interface LandingDef extends ToolDef {
  /** The tool in TOOLS this page is a preset of. */
  baseSlug: string;
  /** Verb phrase for the "How to …" heading, where `name` alone reads badly. */
  howToName: string;
}

type LandingInput = Pick<
  LandingDef,
  | 'slug' | 'baseSlug' | 'name' | 'howToName' | 'shortDescription' | 'longDescription'
  | 'primaryKeyword' | 'pageTitle' | 'metaDescription' | 'h1' | 'faqs' | 'howToSteps' | 'features'
> & { relatedSlugs?: string[] };

function landing(input: LandingInput): LandingDef {
  const base = getToolBySlug(input.baseSlug);
  if (!base) throw new Error(`landing page "${input.slug}" has unknown base tool "${input.baseSlug}"`);
  return {
    ...base,
    ...input,
    // The base tool always leads the related list — it is the fuller version of this page.
    relatedSlugs: input.relatedSlugs ?? [base.slug, ...base.relatedSlugs],
  };
}

export const LANDING_PAGES: LandingDef[] = [
  // ─── PDF ───────────────────────────────────────────────────────────────
  landing({
    slug: 'rotate-pdf',
    baseSlug: 'rearrange-pdf-pages',
    name: 'Rotate PDF',
    howToName: 'Rotate a PDF',
    shortDescription: 'Turn PDF pages and save the result',
    longDescription: 'Rotate every page of a PDF at once, or only the pages that are sideways or upside down. The rotation is saved into the file, so it opens the right way round everywhere.',
    primaryKeyword: 'rotate pdf',
    pageTitle: 'Rotate PDF Online — Turn Pages & Save | Docukit',
    metaDescription: 'Rotate PDF pages online and save them permanently. Turn the whole document or just the sideways pages, left or right. Runs in your browser — no uploads.',
    h1: 'Rotate PDF Pages',
    faqs: [
      { q: 'How do I rotate all pages at once?', a: 'Use "Rotate all left" or "Rotate all right" in the toolbar above the page thumbnails. Each click turns every page by 90°.' },
      { q: 'Can I rotate just one page?', a: 'Yes — hover the page thumbnail and use its rotate buttons. Only that page turns.' },
      { q: 'Can I rotate some pages but not others?', a: 'Yes — select the pages with Ctrl+click or Shift+click. The toolbar buttons then read "Rotate selected" and only turn those pages.' },
      { q: 'Is the rotation permanent?', a: 'Yes. Unlike rotating the view in a PDF reader, the downloaded file stores the new orientation, so it opens rotated in every app and prints that way.' },
      { q: 'Does rotating reduce quality?', a: 'No. Only the orientation of each page changes — the text and images on the page are not re-compressed.' },
      { q: 'I rotated the wrong way. Can I go back?', a: 'Yes — click Undo or press Ctrl+Z, or simply rotate in the other direction before downloading.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. A thumbnail of every page appears.' },
      { title: 'Rotate the pages', description: 'Use the toolbar to turn all pages left or right, or hover a single page to rotate only that one.' },
      { title: 'Download the result', description: 'Click "Apply & Download" to save a PDF with the new orientation.' },
    ],
    features: [
      'Rotate 90° CW/CCW per page or batch',
      'Multi-select with Ctrl+click / Shift+click',
      'Undo/redo up to 20 actions',
    ],
  }),
  landing({
    slug: 'delete-pdf-pages',
    baseSlug: 'split-pdf',
    name: 'Delete PDF Pages',
    howToName: 'Delete Pages from a PDF',
    shortDescription: 'Remove unwanted pages from a PDF',
    longDescription: 'Remove blank, duplicate or unwanted pages from a PDF and download what is left. List the pages to delete — single pages, ranges, or every odd or even page.',
    primaryKeyword: 'delete pages from pdf',
    pageTitle: 'Delete Pages from PDF Online — No Upload | Docukit',
    metaDescription: 'Delete pages from a PDF online. Remove single pages, ranges, or all odd or even pages and download the rest. Runs in your browser — no uploads.',
    h1: 'Delete Pages from a PDF',
    relatedSlugs: ['split-pdf', 'rearrange-pdf-pages', 'merge-pdf', 'compress-pdf'],
    faqs: [
      { q: 'How do I say which pages to delete?', a: 'Type them in the page field: single pages ("3"), ranges ("5-8"), or a mix separated by commas ("1, 4-6, 10"). A counter shows how many pages are selected.' },
      { q: 'Can I delete every other page?', a: 'Yes — type "odd" or "even". This is useful for removing the blank backs from a double-sided scan.' },
      { q: 'How do I remove only the last page?', a: 'Type "last". You do not need to know how many pages the document has.' },
      { q: 'Is my original file changed?', a: 'No. Your original stays as it is on your device — you download a new PDF without the deleted pages.' },
      { q: 'Are the remaining pages re-compressed?', a: 'No. The pages you keep are copied across as they are, so their text and images are unchanged.' },
      { q: 'I would rather see the pages while I delete them.', a: 'Use Rearrange PDF Pages instead: it shows a thumbnail of every page with a delete button, and you can undo.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. This page opens with "Remove Pages" already selected.' },
      { title: 'List the pages to delete', description: 'Type the pages to remove — for example "2, 5-7" or "even". Everything else is kept.' },
      { title: 'Download the result', description: 'Click "Split PDF", then download the PDF without those pages.' },
    ],
    features: [
      'Text syntax: "1-5, 8, odd, even, last"',
      'Range input with live page count',
      '5 split modes',
    ],
  }),
  landing({
    slug: 'extract-pdf-pages',
    baseSlug: 'split-pdf',
    name: 'Extract PDF Pages',
    howToName: 'Extract Pages from a PDF',
    shortDescription: 'Save chosen pages as a new PDF',
    longDescription: 'Pull the pages you need out of a long PDF and save them as a new, smaller document — one chapter, a single form, or a handful of pages from across the file.',
    primaryKeyword: 'extract pages from pdf',
    pageTitle: 'Extract Pages from PDF Online — No Upload | Docukit',
    metaDescription: 'Extract pages from a PDF online. Pick single pages or ranges and save them as a new PDF, or get every page as its own file. Runs in your browser — no uploads.',
    h1: 'Extract Pages from a PDF',
    relatedSlugs: ['split-pdf', 'merge-pdf', 'rearrange-pdf-pages', 'compress-pdf'],
    faqs: [
      { q: 'How do I choose the pages to extract?', a: 'Type them in the page field: single pages ("3"), ranges ("5-8"), or a mix ("1, 4-6, 10"). "odd", "even" and "last" work too.' },
      { q: 'Do the extracted pages end up in one file?', a: 'Yes — "Extract Pages" produces a single PDF containing just the pages you chose.' },
      { q: 'Can I save every page as a separate PDF?', a: 'Yes — switch the mode to "Extract Each Page". You get a ZIP with one PDF per page.' },
      { q: 'Can I split the PDF into several parts instead?', a: 'Yes — "Split by Range" turns each range you list into its own PDF, and "Split Every N" cuts the document into equal chunks.' },
      { q: 'Is the quality of the extracted pages affected?', a: 'No. Pages are copied into the new file as they are; nothing is re-compressed.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. "Extract Pages" is selected by default.' },
      { title: 'Choose the pages', description: 'Type the pages you want — for example "1-3, 8". The counter confirms how many are selected.' },
      { title: 'Download the new PDF', description: 'Click "Split PDF" and download a PDF containing only those pages.' },
    ],
    features: [
      '5 split modes',
      'Text syntax: "1-5, 8, odd, even, last"',
      'Range input with live page count',
      'ZIP output for multi-file splits',
    ],
  }),
  landing({
    slug: 'compress-pdf-to-100kb',
    baseSlug: 'compress-pdf',
    name: 'Compress PDF to 100KB',
    howToName: 'Compress a PDF to 100KB',
    shortDescription: 'Shrink a PDF to under 100KB',
    longDescription: 'Get a PDF under 100KB for an exam, admission or government form. The limit is already set — add your file and its images are compressed only as far as needed to fit.',
    primaryKeyword: 'compress pdf to 100kb',
    pageTitle: 'Compress PDF to 100KB Online — No Upload | Docukit',
    metaDescription: 'Compress a PDF to 100KB or less online, for exam and application forms. Images are reduced only as much as needed. Runs in your browser — no uploads.',
    h1: 'Compress a PDF to 100KB',
    relatedSlugs: ['compress-pdf', 'split-pdf', 'compress-image', 'merge-pdf'],
    faqs: [
      { q: 'How does it get the PDF under 100KB?', a: 'It tries progressively stronger image compression and keeps the mildest setting whose result fits, so no more quality is given up than the limit demands.' },
      { q: 'What if my PDF cannot be reduced to 100KB?', a: 'You are told plainly, and given the smallest version that could be produced. A document that is mostly text or vector graphics has little left to compress — splitting it into parts is the reliable fix.' },
      { q: 'Will a scanned document still be readable at 100KB?', a: 'A one or two page scan usually is. A longer scan squeezed to 100KB will look soft — check the page preview before you submit it.' },
      { q: 'Will the text become blurry?', a: 'No. Text stays as real text and is never turned into a picture. Only the images inside the PDF — photos and scanned pages — are recompressed.' },
      { q: 'Can I use a different size limit?', a: 'Yes — change the number or the unit, or pick one of the presets (100 KB, 200 KB, 500 KB, 1 MB, 2 MB).' },
      { q: 'Is my PDF uploaded anywhere?', a: 'No. The compression runs inside your browser, so certificates, ID documents and statements stay on your device.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. Target size mode is already on, set to 100 KB.' },
      { title: 'Compress', description: 'Click "Compress PDF". Stronger settings are tried only until the file fits the limit.' },
      { title: 'Check and download', description: 'Compare the before and after sizes and the page preview, then download the compressed PDF.' },
    ],
    features: [
      'Target size mode: fit under a KB or MB limit',
      'Side-by-side quality preview',
      'Before/after file size comparison',
    ],
  }),
  landing({
    slug: 'compress-pdf-to-200kb',
    baseSlug: 'compress-pdf',
    name: 'Compress PDF to 200KB',
    howToName: 'Compress a PDF to 200KB',
    shortDescription: 'Shrink a PDF to under 200KB',
    longDescription: 'Bring a PDF under the 200KB limit that job portals, scholarship and university application forms often set. The limit is already entered — just add your file.',
    primaryKeyword: 'compress pdf to 200kb',
    pageTitle: 'Compress PDF to 200KB Online — No Upload | Docukit',
    metaDescription: 'Compress a PDF to 200KB or less online for job and university application portals. Quality is kept as high as the limit allows. Runs in your browser.',
    h1: 'Compress a PDF to 200KB',
    relatedSlugs: ['compress-pdf', 'split-pdf', 'compress-image', 'merge-pdf'],
    faqs: [
      { q: 'How close to 200KB will the result be?', a: 'At or under 200KB. Several compression strengths are tried and the mildest one that fits is kept, so no more quality is given up than the limit requires.' },
      { q: 'My resume is only text. Why is it still over 200KB?', a: 'A text-only PDF is normally small already; when it is large the cause is usually embedded fonts or a photo. If it cannot be brought under the limit you are told, along with the smallest size reached.' },
      { q: 'Does it keep links and bookmarks?', a: 'The document structure is preserved — pages, text and links are kept. Only the images are recompressed.' },
      { q: 'Will the text become blurry?', a: 'No. Text stays as real text and is never turned into a picture. Only the images inside the PDF — photos and scanned pages — are recompressed.' },
      { q: 'Can I use a different size limit?', a: 'Yes — change the number or the unit, or pick one of the presets (100 KB, 200 KB, 500 KB, 1 MB, 2 MB).' },
      { q: 'Is my PDF uploaded anywhere?', a: 'No. The compression runs inside your browser, so certificates, ID documents and statements stay on your device.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. Target size mode is already on, set to 200 KB.' },
      { title: 'Compress', description: 'Click "Compress PDF". Stronger settings are tried only until the file fits the limit.' },
      { title: 'Check and download', description: 'Compare the before and after sizes and the page preview, then download the compressed PDF.' },
    ],
    features: [
      'Target size mode: fit under a KB or MB limit',
      'Side-by-side quality preview',
      'Before/after file size comparison',
    ],
  }),
  landing({
    slug: 'compress-pdf-to-1mb',
    baseSlug: 'compress-pdf',
    name: 'Compress PDF to 1MB',
    howToName: 'Compress a PDF to 1MB',
    shortDescription: 'Shrink a PDF to under 1MB',
    longDescription: 'Reduce a large PDF to under 1MB so it can be attached to an email or uploaded to a visa, bank or tax portal. The limit is already set to 1 MB — add your file to start.',
    primaryKeyword: 'compress pdf to 1mb',
    pageTitle: 'Compress PDF to 1MB Online — No Upload | Docukit',
    metaDescription: 'Compress a PDF to 1MB or less online for email attachments and upload portals. Images are reduced only as far as needed. Runs in your browser — no uploads.',
    h1: 'Compress a PDF to 1MB',
    relatedSlugs: ['compress-pdf', 'split-pdf', 'compress-image', 'merge-pdf'],
    faqs: [
      { q: 'Will the quality still be good at 1MB?', a: 'For most documents, yes. 1MB leaves room for clear images in a file of a few pages; a long scanned document will be compressed harder to fit.' },
      { q: 'My PDF is already under 1MB. Will it be changed?', a: 'It gets only a lossless clean-up, with no image quality lost, and the result is never larger than what you started with.' },
      { q: 'What if it cannot get down to 1MB?', a: 'You are told, and given the smallest version produced. For a very long scan, split it into parts and compress each one.' },
      { q: 'Will the text become blurry?', a: 'No. Text stays as real text and is never turned into a picture. Only the images inside the PDF — photos and scanned pages — are recompressed.' },
      { q: 'Can I use a different size limit?', a: 'Yes — change the number or the unit, or pick one of the presets (100 KB, 200 KB, 500 KB, 1 MB, 2 MB).' },
      { q: 'Is my PDF uploaded anywhere?', a: 'No. The compression runs inside your browser, so certificates, ID documents and statements stay on your device.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. Target size mode is already on, set to 1 MB.' },
      { title: 'Compress', description: 'Click "Compress PDF". Stronger settings are tried only until the file fits the limit.' },
      { title: 'Check and download', description: 'Compare the before and after sizes and the page preview, then download the compressed PDF.' },
    ],
    features: [
      'Target size mode: fit under a KB or MB limit',
      'Side-by-side quality preview',
      'Before/after file size comparison',
    ],
  }),
  landing({
    slug: 'pdf-to-jpg',
    baseSlug: 'pdf-to-image',
    name: 'PDF to JPG',
    howToName: 'Convert a PDF to JPG',
    shortDescription: 'Save PDF pages as JPG images',
    longDescription: 'Turn each page of a PDF into a JPG image. Choose the resolution and quality, convert every page or just a range, and download the images together as a ZIP.',
    primaryKeyword: 'pdf to jpg',
    pageTitle: 'PDF to JPG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert PDF pages to JPG images online. Pick the DPI and quality, convert all pages or a range, and download a ZIP. Runs in your browser — no uploads.',
    h1: 'Convert PDF to JPG',
    faqs: [
      { q: 'Do I get one JPG per page?', a: 'Yes — every page you convert becomes its own JPG. A single page downloads as an image; several pages download together as a ZIP.' },
      { q: 'Which DPI should I choose?', a: '150 DPI suits most uses, including on-screen viewing and ordinary printing. Use 300 DPI for high-quality prints, 72 DPI for the smallest files, or enter a custom value up to 600.' },
      { q: 'Can I convert only some pages?', a: 'Yes — switch from all pages to a page range and enter the pages you want, such as "1-3".' },
      { q: 'How do I make the JPGs smaller?', a: 'Lower the quality slider or the DPI. Quality around 85% keeps text sharp at a much smaller size than the maximum.' },
      { q: 'Can I get PNG instead?', a: 'Yes — JPG is pre-selected on this page, but the same tool also exports PNG, WebP and AVIF. Choose PNG when you need lossless text edges.' },
    ],
    howToSteps: [
      { title: 'Upload your PDF', description: 'Drop your PDF into the upload area. JPEG is already selected as the output format.' },
      { title: 'Set resolution and quality', description: 'Choose the DPI and JPG quality, and whether to convert all pages or a range.' },
      { title: 'Download the JPGs', description: 'Click "Convert to JPEG" — get a single image, or a ZIP when there are several pages.' },
    ],
    features: [
      'PNG, JPEG, WebP, AVIF output',
      'Custom DPI up to 600',
      'Single page, all pages, or page range',
      'ZIP download for multi-page exports',
    ],
  }),
  landing({
    slug: 'jpg-to-pdf',
    baseSlug: 'image-to-pdf',
    name: 'JPG to PDF',
    howToName: 'Convert JPG to PDF',
    shortDescription: 'Combine JPG photos into one PDF',
    longDescription: 'Turn one or more JPG photos into a single PDF — scanned receipts, ID cards, homework or phone photos of a document. Put them in order and choose the page size.',
    primaryKeyword: 'jpg to pdf',
    pageTitle: 'JPG to PDF Converter Online — No Upload | Docukit',
    metaDescription: 'Convert JPG images to PDF online. Combine several photos into one PDF, drag them into order and choose the page size. Runs in your browser — no uploads.',
    h1: 'Convert JPG to PDF',
    faqs: [
      { q: 'Can I put several JPGs into one PDF?', a: 'Yes — add as many images as you need. Each one becomes a page, and they are all saved into a single PDF.' },
      { q: 'How do I change the page order?', a: 'Drag the images into the order you want before converting. The PDF pages follow that order.' },
      { q: 'What page size will the PDF have?', a: 'You choose: "Fit Image" makes each page match its photo, or pick A4, Letter, Legal or a custom size for a standard document.' },
      { q: 'Does it work with photos from my phone?', a: 'Yes — JPG photos from any phone camera work directly. Add them straight from your gallery.' },
      { q: 'Can I add PNG or other images too?', a: 'Yes — you can mix JPG with PNG, WebP and other supported formats in the same PDF.' },
    ],
    howToSteps: [
      { title: 'Add your JPGs', description: 'Drop one or more JPG images into the upload area. Drag to reorder — each becomes a page.' },
      { title: 'Choose the page layout', description: 'Pick a page size such as Fit Image or A4. The setting applies to every page.' },
      { title: 'Download the PDF', description: 'Click the convert button to build the PDF and download it.' },
    ],
    features: [
      'JPEG, PNG, WebP, BMP, TIFF, SVG, HEIC support',
      'Multi-image drag-and-drop reorder',
      'Fit Image, A4, Letter, Legal, custom page sizes',
    ],
  }),

  // ─── IMAGE ─────────────────────────────────────────────────────────────
  landing({
    slug: 'png-to-jpg',
    baseSlug: 'convert-image',
    name: 'PNG to JPG',
    howToName: 'Convert PNG to JPG',
    shortDescription: 'Turn PNG images into smaller JPGs',
    longDescription: 'Convert PNG images to JPG to make them smaller and accepted everywhere — handy for screenshots and photos saved as PNG. Convert one image or a whole batch.',
    primaryKeyword: 'png to jpg',
    pageTitle: 'PNG to JPG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert PNG to JPG online. Shrink screenshots and photos, set the JPG quality, and convert a whole batch at once. Runs in your browser — no uploads.',
    h1: 'Convert PNG to JPG',
    faqs: [
      { q: 'What happens to transparent areas?', a: 'JPG cannot store transparency, so transparent areas are filled with white. Keep the image as PNG, or convert to WebP, if you need the transparency.' },
      { q: 'Will the JPG be smaller than the PNG?', a: 'For photos and detailed screenshots, usually much smaller. Simple graphics with flat colours can already be tiny as PNG and may not shrink.' },
      { q: 'What quality should I use?', a: 'The default of 85% is a good balance. Lower it for smaller files; raise it if you can see blocky artefacts around text or edges.' },
      { q: 'Can I convert many PNGs at once?', a: 'Yes — add several images and they are all converted with the same settings. You download them together as a ZIP.' },
      { q: 'Is JPG and JPEG the same thing?', a: 'Yes. They are two spellings of the same format; the files are identical.' },
    ],
    howToSteps: [
      { title: 'Add your PNGs', description: 'Drop one or more PNG images into the upload area. JPEG is already selected as the output.' },
      { title: 'Set the quality', description: 'Adjust the quality slider if you want smaller files or sharper detail.' },
      { title: 'Download the JPGs', description: 'Click the convert button — get a single JPG, or a ZIP for a batch.' },
    ],
    features: [
      'Batch conversion to same format',
      'Per-format quality settings',
      'JPEG, PNG, WebP, AVIF, BMP, TIFF, ICO, GIF, SVG',
    ],
  }),
  landing({
    slug: 'jpg-to-png',
    baseSlug: 'convert-image',
    name: 'JPG to PNG',
    howToName: 'Convert JPG to PNG',
    shortDescription: 'Save JPG images as lossless PNG',
    longDescription: 'Convert JPG images to PNG when a site or app asks for PNG, or before editing so the image is not re-compressed each time you save. Convert one image or a batch.',
    primaryKeyword: 'jpg to png',
    pageTitle: 'JPG to PNG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert JPG to PNG online. Get lossless PNG files for editing or upload forms, one image or a whole batch. Runs in your browser — no uploads.',
    h1: 'Convert JPG to PNG',
    faqs: [
      { q: 'Will converting to PNG improve the quality?', a: 'No. PNG stores the image exactly as it is now, so it stops further quality loss, but detail the JPG already lost cannot be recovered.' },
      { q: 'Why is the PNG larger than the JPG?', a: 'PNG is lossless and stores every pixel exactly, which takes more space for photos. That is expected.' },
      { q: 'Does the PNG get a transparent background?', a: 'No. A JPG has no transparency, so the PNG is fully opaque too. Converting formats does not remove a background.' },
      { q: 'Can I convert many JPGs at once?', a: 'Yes — add several images and they are all converted together. You download them as a ZIP.' },
    ],
    howToSteps: [
      { title: 'Add your JPGs', description: 'Drop one or more JPG images into the upload area. PNG is already selected as the output.' },
      { title: 'Check the list', description: 'Remove any image you added by mistake, or add more.' },
      { title: 'Download the PNGs', description: 'Click the convert button — get a single PNG, or a ZIP for a batch.' },
    ],
    features: [
      'Batch conversion to same format',
      'JPEG, PNG, WebP, AVIF, BMP, TIFF, ICO, GIF, SVG',
    ],
  }),
  landing({
    slug: 'webp-to-jpg',
    baseSlug: 'convert-image',
    name: 'WebP to JPG',
    howToName: 'Convert WebP to JPG',
    shortDescription: 'Make WebP images open anywhere',
    longDescription: 'Convert WebP images saved from the web into JPG, so they open in older apps, upload to sites that reject WebP, and attach cleanly to documents and emails.',
    primaryKeyword: 'webp to jpg',
    pageTitle: 'WebP to JPG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert WebP to JPG online. Make images saved from the web work in any app or upload form, one at a time or in a batch. Runs in your browser — no uploads.',
    h1: 'Convert WebP to JPG',
    faqs: [
      { q: 'Why did my image save as WebP?', a: 'Many websites serve pictures as WebP because the files are small. Browsers open it fine, but some editors, older apps and upload forms do not accept it.' },
      { q: 'What happens to transparent areas?', a: 'JPG cannot store transparency, so transparent areas are filled with white. Convert to PNG instead if you need to keep them.' },
      { q: 'Will the JPG look the same?', a: 'At the default 85% quality the difference is rarely visible. Raise the quality slider if you notice artefacts.' },
      { q: 'Can I convert several WebP files at once?', a: 'Yes — add them all and they are converted with the same settings. You download them together as a ZIP.' },
    ],
    howToSteps: [
      { title: 'Add your WebP images', description: 'Drop one or more WebP files into the upload area. JPEG is already selected as the output.' },
      { title: 'Set the quality', description: 'Leave the quality at the default, or adjust it for smaller files or sharper detail.' },
      { title: 'Download the JPGs', description: 'Click the convert button — get a single JPG, or a ZIP for a batch.' },
    ],
    features: [
      'Batch conversion to same format',
      'Per-format quality settings',
      'JPEG, PNG, WebP, AVIF, BMP, TIFF, ICO, GIF, SVG',
    ],
  }),
  landing({
    slug: 'webp-to-png',
    baseSlug: 'convert-image',
    name: 'WebP to PNG',
    howToName: 'Convert WebP to PNG',
    shortDescription: 'Convert WebP to PNG, transparency kept',
    longDescription: 'Convert WebP images to PNG without losing transparency — the right choice for logos, icons and cut-out graphics that need to work in editors and apps that do not read WebP.',
    primaryKeyword: 'webp to png',
    pageTitle: 'WebP to PNG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert WebP to PNG online and keep transparent backgrounds. Ideal for logos and graphics, one image or a batch. Runs in your browser — no uploads.',
    h1: 'Convert WebP to PNG',
    faqs: [
      { q: 'Is transparency preserved?', a: 'Yes. PNG supports transparency, so transparent areas in the WebP stay transparent in the PNG.' },
      { q: 'Should I choose PNG or JPG?', a: 'Choose PNG for logos, icons, screenshots and anything with transparency. Choose JPG for photographs, where it gives much smaller files.' },
      { q: 'Why is the PNG bigger than the WebP?', a: 'WebP compresses more efficiently than PNG. A larger PNG is normal and does not mean anything went wrong.' },
      { q: 'Can I convert several WebP files at once?', a: 'Yes — add them all and they are converted together. You download them as a ZIP.' },
    ],
    howToSteps: [
      { title: 'Add your WebP images', description: 'Drop one or more WebP files into the upload area. PNG is already selected as the output.' },
      { title: 'Check the list', description: 'Remove any image you added by mistake, or add more.' },
      { title: 'Download the PNGs', description: 'Click the convert button — get a single PNG, or a ZIP for a batch.' },
    ],
    features: [
      'Batch conversion to same format',
      'JPEG, PNG, WebP, AVIF, BMP, TIFF, ICO, GIF, SVG',
    ],
  }),
  landing({
    slug: 'heic-to-jpg',
    baseSlug: 'convert-image',
    name: 'HEIC to JPG',
    howToName: 'Convert HEIC to JPG',
    shortDescription: 'Make iPhone photos open anywhere',
    longDescription: 'Convert HEIC photos from an iPhone or iPad to JPG so they open on Windows, upload to any website and attach to documents. The photos are converted on your device, not sent to a server.',
    primaryKeyword: 'heic to jpg',
    pageTitle: 'HEIC to JPG Converter Online — No Upload | Docukit',
    metaDescription: 'Convert iPhone HEIC photos to JPG online. Works on Windows, Mac and phones, one photo or a whole batch, with nothing uploaded — it runs in your browser.',
    h1: 'Convert HEIC to JPG',
    faqs: [
      { q: 'What is a HEIC file?', a: 'HEIC is the format iPhones and iPads use for photos by default. It keeps files small, but many Windows apps, websites and upload forms cannot open it.' },
      { q: 'Why is there no preview of my photo before converting?', a: 'Most browsers cannot display HEIC, so the file shows a placeholder until it is converted. The conversion itself works normally.' },
      { q: 'Can I convert many HEIC photos at once?', a: 'Yes — add them all and they are converted with the same settings. You download them together as a ZIP.' },
      { q: 'Will the JPG look as good as the original?', a: 'At the default 85% quality the difference is rarely visible. Raise the quality slider if you want to keep more detail, at the cost of a larger file.' },
      { q: 'Are my photos uploaded?', a: 'No. The HEIC decoder runs inside your browser, so personal photos never leave your device.' },
      { q: 'Can I convert to PNG instead?', a: 'Yes — JPG is pre-selected on this page, but you can switch the output to PNG, WebP or AVIF before converting.' },
    ],
    howToSteps: [
      { title: 'Add your HEIC photos', description: 'Drop one or more .heic files into the upload area. JPEG is already selected as the output.' },
      { title: 'Set the quality', description: 'Leave the quality at the default, or adjust it for smaller files or more detail.' },
      { title: 'Download the JPGs', description: 'Click the convert button — get a single JPG, or a ZIP for a batch.' },
    ],
    features: [
      'HEIC (iPhone) conversion',
      'Batch conversion to same format',
      'Per-format quality settings',
    ],
  }),
  landing({
    slug: 'compress-image-to-100kb',
    baseSlug: 'compress-image',
    name: 'Compress Image to 100KB',
    howToName: 'Compress an Image to 100KB',
    shortDescription: 'Shrink a photo to under 100KB',
    longDescription: 'Get a photo under 100KB for an application form, job portal or email. The target size is already set — add your image and the quality is tuned automatically to fit.',
    primaryKeyword: 'compress image to 100kb',
    pageTitle: 'Compress Image to 100KB Online — No Upload | Docukit',
    metaDescription: 'Compress an image to 100KB or less online. The quality is tuned automatically to hit the size limit for forms and portals. Runs in your browser — no uploads.',
    h1: 'Compress an Image to 100KB',
    relatedSlugs: ['compress-image', 'resize-image', 'convert-image', 'image-to-pdf'],
    faqs: [
      { q: 'How does it reach exactly 100KB?', a: 'It tries a series of quality levels and keeps the highest one whose file comes in at or under 100KB, so you get the best-looking image that fits.' },
      { q: 'What format is the result?', a: 'JPG, which is what most upload forms ask for. You can switch the output to WebP or AVIF, which look better at the same size where they are accepted.' },
      { q: 'What if my image will not go down to 100KB?', a: 'A very large photo can still be over the limit at the lowest quality. Reduce its dimensions with Resize Image first, then compress it here.' },
      { q: 'Can I use a different size limit?', a: 'Yes — change the number in the Target Size field to any value in KB, such as 20, 50 or 200.' },
      { q: 'Does it change the image dimensions?', a: 'No. The width and height stay the same; only the compression changes. Use Resize Image if the form also requires specific pixel dimensions.' },
      { q: 'Is my photo uploaded anywhere?', a: 'No. The compression runs inside your browser, so ID photos, signatures and documents stay on your device.' },
    ],
    howToSteps: [
      { title: 'Add your image', description: 'Drop a photo into the upload area. Target Size mode is already on, set to 100 KB.' },
      { title: 'Compress', description: 'Click the compress button. The quality is adjusted automatically until the file fits.' },
      { title: 'Check and download', description: 'Compare the before and after sizes, then download the compressed image.' },
    ],
    features: [
      'Quality slider and target file size mode',
      'Before/after size comparison',
      'Batch compression with ZIP download',
    ],
  }),
  landing({
    slug: 'compress-image-to-50kb',
    baseSlug: 'compress-image',
    name: 'Compress Image to 50KB',
    howToName: 'Compress an Image to 50KB',
    shortDescription: 'Shrink a photo to under 50KB',
    longDescription: 'Get a passport photo, signature scan or ID picture under 50KB — the limit many exam and government forms set. The target is already set to 50 KB; just add your image.',
    primaryKeyword: 'compress image to 50kb',
    pageTitle: 'Compress Image to 50KB Online — No Upload | Docukit',
    metaDescription: 'Compress a photo or signature to 50KB or less online, for exam and application forms. Quality is tuned automatically. Runs in your browser — no uploads.',
    h1: 'Compress an Image to 50KB',
    relatedSlugs: ['compress-image', 'resize-image', 'convert-image', 'image-to-pdf'],
    faqs: [
      { q: 'Will a 50KB photo still look acceptable?', a: 'For a passport-style photo or a signature at the small dimensions forms ask for, yes. A full-size camera photo squeezed to 50KB will look rough — resize it first.' },
      { q: 'My photo is still over 50KB. What should I do?', a: 'Reduce its dimensions with Resize Image — most forms only need a few hundred pixels across — then compress the smaller image here.' },
      { q: 'What format is the result?', a: 'JPG, which is what most forms require. You can switch the output format if the form accepts something else.' },
      { q: 'The form wants between 20KB and 50KB. Can I do that?', a: 'Yes — a 50 KB target gives a file at or under 50KB, as close to it as the quality steps allow. For a lower ceiling, change the number in the Target Size field.' },
      { q: 'Is my photo uploaded anywhere?', a: 'No. The compression runs inside your browser, so your photo and signature stay on your device.' },
    ],
    howToSteps: [
      { title: 'Add your image', description: 'Drop your photo or signature scan into the upload area. Target Size mode is already on, set to 50 KB.' },
      { title: 'Compress', description: 'Click the compress button. The quality is adjusted automatically until the file fits.' },
      { title: 'Check and download', description: 'Confirm the new size, then download the compressed image.' },
    ],
    features: [
      'Quality slider and target file size mode',
      'Before/after size comparison',
    ],
  }),
];

export function getLandingBySlug(slug: string): LandingDef | undefined {
  return LANDING_PAGES.find((l) => l.slug === slug);
}

/**
 * The other task pages that share a base tool with `tool` — shown as "popular
 * tasks" on both the base tool page and its sibling landing pages.
 */
export function getSiblingLandings(tool: ToolDef | LandingDef): LandingDef[] {
  const baseSlug = 'baseSlug' in tool ? tool.baseSlug : tool.slug;
  return LANDING_PAGES.filter((l) => l.baseSlug === baseSlug && l.slug !== tool.slug);
}
