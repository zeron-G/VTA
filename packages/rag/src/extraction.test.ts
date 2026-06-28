/**
 * Unit tests for binary material extraction.
 *
 * PDF parsing needs a real PDF byte stream (hard to hand-craft), so it is
 * exercised by the live ingestion path rather than here; these tests cover the
 * type dispatch, the size cap, plain-text decoding, and a synthetic PPTX/DOCX
 * built in-memory with jszip (the same zip layout the real parsers read).
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import {
  detectExtractable,
  isExtractable,
  extractText,
  MAX_EXTRACT_BYTES,
} from './extraction.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detectExtractable', () => {
  it('classifies by content-type', () => {
    expect(detectExtractable({ contentType: 'application/pdf' })).toBe('pdf');
    expect(
      detectExtractable({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe('docx');
    expect(
      detectExtractable({
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).toBe('pptx');
    expect(detectExtractable({ contentType: 'text/plain' })).toBe('text');
  });

  it('classifies by filename extension when content-type is absent/generic', () => {
    expect(detectExtractable({ filename: 'lecture.pdf' })).toBe('pdf');
    expect(detectExtractable({ filename: 'notes.DOCX' })).toBe('docx');
    expect(detectExtractable({ filename: 'slides.pptx' })).toBe('pptx');
    expect(detectExtractable({ filename: 'readme.md' })).toBe('text');
  });

  it('returns undefined for unsupported types (legacy binary, images, archives)', () => {
    expect(detectExtractable({ filename: 'old.doc' })).toBeUndefined();
    expect(detectExtractable({ filename: 'diagram.png' })).toBeUndefined();
    expect(detectExtractable({ contentType: 'application/zip' })).toBeUndefined();
    expect(detectExtractable({})).toBeUndefined();
  });
});

describe('isExtractable', () => {
  it('rejects files over the size cap', () => {
    expect(isExtractable({ filename: 'big.pdf', size: MAX_EXTRACT_BYTES + 1 })).toBe(false);
    expect(isExtractable({ filename: 'ok.pdf', size: 1024 })).toBe(true);
  });
  it('rejects unsupported types regardless of size', () => {
    expect(isExtractable({ filename: 'image.png', size: 10 })).toBe(false);
  });
});

describe('extractText', () => {
  it('returns empty for empty or unsupported input', async () => {
    expect(await extractText(new Uint8Array(0), { filename: 'x.pdf' })).toBe('');
    expect(await extractText(enc('hi'), { filename: 'image.png' })).toBe('');
  });

  it('decodes plain text and normalizes whitespace', async () => {
    const out = await extractText(enc('Hello\r\n\n\n\nworld   .'), { filename: 'a.txt' });
    expect(out).toBe('Hello\n\nworld .');
  });

  it('extracts slide text from a synthetic PPTX in slide order', async () => {
    const zip = new JSZip();
    // Two slides, intentionally added out of order to prove numeric sorting.
    zip.file(
      'ppt/slides/slide2.xml',
      '<p:sld><a:t>Second slide</a:t><a:t>more</a:t></p:sld>',
    );
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>First &amp; only</a:t></p:sld>');
    zip.file('ppt/notesSlides/notesSlide1.xml', '<a:t>speaker notes ignored</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const out = await extractText(bytes, { filename: 'deck.pptx' });
    expect(out).toBe('First & only\n\nSecond slide more');
  });

  it('extracts paragraph text from a synthetic DOCX', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>Course intro.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Week 1 topics.</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const out = await extractText(bytes, { filename: 'syllabus.docx' });
    expect(out).toContain('Course intro.');
    expect(out).toContain('Week 1 topics.');
  });
});
