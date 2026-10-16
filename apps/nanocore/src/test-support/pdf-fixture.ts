/** Produce exact xref offsets rather than relying on Poppler's damaged-file repair. */
export function createPdfFixture(
  pages: readonly string[],
  compressedContent?: Buffer,
  metadataTitle?: string
): Buffer {
  const objects: Buffer[] = [];
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(
    Buffer.from(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`
    )
  );
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  for (const page of pages) {
    const stream =
      compressedContent ??
      (page === '@scanned'
        ? Buffer.concat([
            Buffer.from('q 100 0 0 100 72 600 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID '),
            Buffer.from([255, 255, 255]),
            Buffer.from(' EI Q\n'),
          ])
        : Buffer.from(page ? `BT /F1 12 Tf 72 720 Td (${page}) Tj ET\n` : ''));
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
      )
    );
    objects.push(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${stream.length}${compressedContent ? ' /Filter /FlateDecode' : ''} >>\nstream\n`
        ),
        stream,
        Buffer.from('\nendstream'),
      ])
    );
  }
  if (metadataTitle !== undefined) objects.push(Buffer.from(`<< /Title (${metadataTitle}) >>`));
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length);
    const body = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(body);
    length += body.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
          ''
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${metadataTitle === undefined ? '' : ` /Info ${objects.length} 0 R`} >>\nstartxref\n${length}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}
