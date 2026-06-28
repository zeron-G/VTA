/**
 * Text extraction for binary course materials (PDF / DOCX / PPTX) and plain text.
 *
 * Canvas "Files" are uploaded documents — lecture slides, readings, handouts —
 * which carry most of a course's substance but are NOT covered by the HTML
 * resource endpoints (pages/assignments/announcements/modules/syllabus). This
 * module turns a downloaded file's bytes into plain text the RAG pipeline can
 * chunk and embed.
 *
 * The heavy parsers (`unpdf`/pdf.js, `mammoth`, `jszip`) are loaded with DYNAMIC
 * import so they never enter the answering worker's hot path — only the admin
 * ingestion path that actually extracts a file pays the load cost.
 */

/** Hard cap: never download/parse a file larger than this (bytes). */
export const MAX_EXTRACT_BYTES = 25 * 1024 * 1024; // 25 MB

/** What we know about a file before/while extracting it. */
export interface ExtractInput {
  readonly filename?: string;
  readonly contentType?: string;
}

/** The document kinds we can extract text from. */
type Extractable = 'pdf' | 'docx' | 'pptx' | 'text';

/**
 * Decide whether (and how) a file can be extracted, from its MIME type and/or
 * filename extension. Returns `undefined` for unsupported types (legacy binary
 * .doc/.ppt, images, archives, spreadsheets, etc.).
 */
export function detectExtractable(opts: ExtractInput): Extractable | undefined {
  const ct = (opts.contentType ?? '').toLowerCase();
  const name = (opts.filename ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  if (ct.includes('application/pdf') || ext === 'pdf') return 'pdf';
  if (ct.includes('officedocument.wordprocessingml') || ext === 'docx') return 'docx';
  if (ct.includes('officedocument.presentationml') || ext === 'pptx') return 'pptx';
  if (ct.startsWith('text/') || ['txt', 'md', 'markdown', 'csv', 'tsv'].includes(ext)) {
    return 'text';
  }
  return undefined;
}

/** True when a file is worth downloading + extracting (supported type, within size cap). */
export function isExtractable(opts: ExtractInput & { size?: number }): boolean {
  if (typeof opts.size === 'number' && opts.size > MAX_EXTRACT_BYTES) return false;
  return detectExtractable(opts) !== undefined;
}

/**
 * Extract plain text from a file's bytes. Returns `''` for unsupported types,
 * over-size input, or a document with no extractable text. Parser errors
 * propagate to the caller (ingestion logs + skips the single file).
 */
export async function extractText(bytes: Uint8Array, opts: ExtractInput): Promise<string> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXTRACT_BYTES) return '';
  const kind = detectExtractable(opts);
  if (kind === undefined) return '';

  switch (kind) {
    case 'pdf':
      return normalizeText(await extractPdf(bytes));
    case 'docx':
      return normalizeText(await extractDocx(bytes));
    case 'pptx':
      return normalizeText(await extractPptx(bytes));
    case 'text':
      return normalizeText(decodeUtf8(bytes));
  }
}

/* -------------------------------------------------------------------------- */
/* Per-format extractors (parsers loaded lazily via dynamic import).          */
/* -------------------------------------------------------------------------- */

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText: pdfExtractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await pdfExtractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n\n') : text;
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

async function extractPptx(bytes: Uint8Array): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  // Slide text lives at ppt/slides/slideN.xml as <a:t>…</a:t> runs. Read slides
  // in numeric order so the deck reads top-to-bottom.
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides: string[] = [];
  for (const path of slidePaths) {
    const entry = zip.files[path];
    if (entry === undefined) continue;
    const xml = await entry.async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1] ?? ''));
    const text = runs.join(' ').trim();
    if (text !== '') slides.push(text);
  }
  return slides.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                   */
/* -------------------------------------------------------------------------- */

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function slideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/.exec(path);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Collapse whitespace so extracted text hashes/chunks stably. */
function normalizeText(text: string): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ') // non-breaking space -> regular space
    .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces/tabs
    .replace(/[ \t]+\n/g, '\n') // strip trailing spaces before newlines
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
    .trim();
}
