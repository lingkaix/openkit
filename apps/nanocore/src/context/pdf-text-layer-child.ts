import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PdfPageLocator, PdfTextLayerLimits } from './pdf-text-layer.js';

/** Fixed text-only options; current PDF.js also removes eval, and Node forbids string code generation. */
export const PDF_TEXT_LAYER_OPTIONS = Object.freeze({
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  useWasm: false,
  enableXfa: false,
  stopAtErrors: true,
} as const);

/** Parses only the privately staged file in this short-lived child; no parser is imported by the parent. */
async function extract(): Promise<void> {
  const sourcePath = process.argv[2]!;
  const limits = JSON.parse(process.argv[3]!) as PdfTextLayerLimits;
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    process.exitCode = 5;
    return;
  }
  const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength > limits.maxInputBytes) {
    process.exitCode = 4;
    return;
  }
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...PDF_TEXT_LAYER_OPTIONS,
    verbosity: 0,
    cMapUrl: join(packageRoot, 'cmaps') + sep,
    standardFontDataUrl: join(packageRoot, 'standard_fonts') + sep,
  });
  try {
    const document = await loading.promise;
    const { info } = await document.getMetadata();
    if ((info as { EncryptFilterName?: string | null }).EncryptFilterName != null) {
      process.exitCode = 3;
      return;
    }
    let text = '';
    let byteLength = 0;
    const pages: PdfPageLocator[] = [];
    const append = (value: string) => {
      const size = Buffer.byteLength(value);
      if (size > limits.maxOutputBytes - byteLength) throw new RangeError('Text ceiling.');
      text += value;
      byteLength += size;
    };
    for (let number = 1; number <= Math.min(document.numPages, limits.maxPages); number++) {
      append(`# Page ${number}\n\n`);
      const startByte = byteLength;
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      let hasText = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            hasText ||= item.str.trim().length > 0;
            append(item.str);
            if (item.hasEOL) append('\n');
          }
        }
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
      if (byteLength > startByte && !text.endsWith('\n')) append('\n');
      pages.push({
        page: number,
        coordinateSpace: 'representation-utf8',
        startByte,
        endByte: byteLength,
        hasText,
      });
      append('\n');
    }
    process.stdout.write(JSON.stringify({ text, pages, totalPages: document.numPages }));
  } catch (error) {
    process.exitCode = error instanceof RangeError ? 4 :
      error instanceof Error && error.name === 'PasswordException' ? 3 : 2;
  } finally {
    await loading.destroy();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void extract().catch(() => { process.exitCode = 2; });
}
