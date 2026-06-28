/**
 * Content normalization: Canvas HTML -> clean Markdown, stable content hashing,
 * and formatters that turn each typed Canvas resource into a
 * `NormalizedMaterial` ready for the RAG ingestion pipeline.
 *
 * The Markdown body is what RAG chunks and embeds, so it must be deterministic:
 * the same source HTML always yields the same Markdown and therefore the same
 * `contentHash`. That hash is the idempotency key the ingestion layer uses to
 * skip unchanged sources (see `materials.contentHash` in `@vta/data`).
 */

import { createHash } from 'node:crypto';
import TurndownService from 'turndown';

import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCourse,
  CanvasFile,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
  NormalizedMaterial,
} from './types.js';

/**
 * A single shared, configured turndown instance.
 *
 * Config per spec:
 *   - `headingStyle: 'atx'`    -> `# H1` rather than underlined Setext headings.
 *   - `codeBlockStyle: 'fenced'` -> ```fenced``` blocks rather than indented.
 * Additional defensible defaults for clean, stable output:
 *   - `bulletListMarker: '-'`  -> consistent list bullets.
 *   - `emDelimiter: '_'`       -> avoids `*`/`**` ambiguity with bold.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});

/**
 * Convert Canvas-rendered HTML into Markdown.
 *
 * Robust to the messy inputs Canvas produces: returns an empty string for
 * null/undefined/blank input rather than throwing, and collapses the runs of
 * blank lines turndown can emit so hashing stays stable.
 */
export function htmlToMarkdown(html: string): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  const md = turndown.turndown(html);
  return normalizeWhitespace(md);
}

/** Collapse 3+ consecutive newlines to 2, trim trailing spaces, and trim ends. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stable SHA-256 hex digest of a string. Used as the idempotency key for
 * ingestion. We hash the normalized Markdown body (not the raw HTML) so that
 * cosmetic HTML changes that produce identical Markdown do not force a
 * re-embed.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build a NormalizedMaterial from already-computed parts. Centralizes the
 * contentHash computation so every formatter hashes the body identically.
 */
function makeMaterial(parts: {
  externalId: string;
  title: string;
  kind: string;
  markdown: string;
  uri?: string;
}): NormalizedMaterial {
  const base: NormalizedMaterial = {
    sourceType: 'canvas',
    externalId: parts.externalId,
    title: parts.title,
    kind: parts.kind,
    markdown: parts.markdown,
    contentHash: contentHash(parts.markdown),
    ...(parts.uri !== undefined ? { uri: parts.uri } : {}),
  };
  return base;
}

/** Fallback title when Canvas returns an empty/whitespace title. */
function safeTitle(title: string | undefined, fallback: string): string {
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  return fallback;
}

/**
 * A Canvas wiki page -> NormalizedMaterial.
 * `externalId` uses the page slug, which is stable across edits.
 */
export function toNormalizedPage(page: CanvasPage): NormalizedMaterial {
  const title = safeTitle(page.title, `Page ${page.url}`);
  const markdown = htmlToMarkdown(page.body ?? '');
  return makeMaterial({
    externalId: `page:${page.url}`,
    title,
    kind: 'page',
    markdown,
  });
}

/**
 * A Canvas assignment -> NormalizedMaterial.
 * Prepends a small metadata header (due date / points) above the prompt body so
 * that information survives into the chunked text the model retrieves.
 */
export function toNormalizedAssignment(assignment: CanvasAssignment): NormalizedMaterial {
  const title = safeTitle(assignment.name, `Assignment ${assignment.id}`);
  const body = htmlToMarkdown(assignment.description ?? '');

  const metaLines: string[] = [];
  if (assignment.due_at) metaLines.push(`**Due:** ${assignment.due_at}`);
  if (assignment.points_possible != null) {
    metaLines.push(`**Points:** ${assignment.points_possible}`);
  }
  const markdown = joinSections([`# ${title}`, metaLines.join('  \n'), body]);

  return makeMaterial({
    externalId: `assignment:${assignment.id}`,
    title,
    kind: 'assignment',
    markdown,
    ...(assignment.html_url !== undefined ? { uri: assignment.html_url } : {}),
  });
}

/**
 * A Canvas announcement (discussion topic) -> NormalizedMaterial.
 */
export function toNormalizedAnnouncement(
  announcement: CanvasAnnouncement,
): NormalizedMaterial {
  const title = safeTitle(announcement.title, `Announcement ${announcement.id}`);
  const body = htmlToMarkdown(announcement.message ?? '');
  const postedLine = announcement.posted_at ? `**Posted:** ${announcement.posted_at}` : '';
  const markdown = joinSections([`# ${title}`, postedLine, body]);

  return makeMaterial({
    externalId: `announcement:${announcement.id}`,
    title,
    kind: 'announcement',
    markdown,
    ...(announcement.html_url !== undefined ? { uri: announcement.html_url } : {}),
  });
}

/**
 * A Canvas module (with its items) -> NormalizedMaterial.
 *
 * Modules have no prose body of their own; the useful indexable content is the
 * ORDERED LIST OF ITEMS (their titles and types), which captures the course's
 * structure. We render that as a Markdown list.
 */
export function toNormalizedModule(module: CanvasModule): NormalizedMaterial {
  const title = safeTitle(module.name, `Module ${module.id}`);
  const items = module.items ?? [];
  const lines = items.map((item) => renderModuleItem(item));
  const markdown = joinSections([`# ${title}`, lines.join('\n')]);

  return makeMaterial({
    externalId: `module:${module.id}`,
    title,
    kind: 'module',
    markdown,
  });
}

/** Render one module item as a Markdown list line, e.g. "- Lecture 1 (Page)". */
function renderModuleItem(item: CanvasModuleItem): string {
  const label = safeTitle(item.title, `Item ${item.id}`);
  const indent = '  '.repeat(Math.max(0, item.indent ?? 0));
  const kind = item.type ? ` (${item.type})` : '';
  if (item.html_url) return `${indent}- [${label}](${item.html_url})${kind}`;
  if (item.external_url) return `${indent}- [${label}](${item.external_url})${kind}`;
  return `${indent}- ${label}${kind}`;
}

/**
 * A Canvas File (uploaded document) -> NormalizedMaterial.
 *
 * Unlike the HTML resources, a file's text is EXTRACTED from its binary content
 * by the RAG layer (PDF/DOCX/PPTX/plain-text) and passed in here already as
 * plain text — so we store it directly as the body (no HTML→Markdown step). The
 * short-lived download URL is intentionally NOT persisted as `uri` (it expires).
 */
export function toNormalizedFile(file: CanvasFile, extractedText: string): NormalizedMaterial {
  const title = safeTitle(file.display_name ?? file.filename, `File ${file.id}`);
  return makeMaterial({
    externalId: `file:${file.id}`,
    title,
    kind: 'file',
    markdown: extractedText,
  });
}

/**
 * A course's syllabus -> NormalizedMaterial.
 *
 * Takes the course (for the title and the canonical id) plus the already-fetched
 * `syllabus_body` HTML. We pass the HTML explicitly because the syllabus is only
 * present on the course object when requested with `include[]=syllabus_body`.
 */
export function toNormalizedSyllabus(
  course: CanvasCourse,
  syllabusHtml: string | null | undefined,
): NormalizedMaterial {
  const courseName = safeTitle(course.name, `Course ${course.id}`);
  const title = `${courseName} — Syllabus`;
  const markdown = htmlToMarkdown(syllabusHtml ?? '');
  return makeMaterial({
    externalId: `syllabus:${course.id}`,
    title,
    kind: 'syllabus',
    markdown,
  });
}

/** Join non-empty sections with a blank line and normalize the result. */
function joinSections(sections: readonly string[]): string {
  const joined = sections
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n\n');
  return normalizeWhitespace(joined);
}
