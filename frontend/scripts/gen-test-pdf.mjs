import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const outPath = resolve('public/test-fixtures/sample.pdf')

function escapePdfString(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
}

function streamObject(id, content) {
  const bytes = Buffer.byteLength(content, 'latin1')
  return `${id} 0 obj\n<< /Length ${bytes} >>\nstream\n${content}\nendstream\nendobj\n`
}

const objects = new Map()
const pageObjectIds = [3, 4, 5, 6, 7]
const contentObjectIds = [8, 9, 10, 11, 12]

objects.set(
  1,
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 14 0 R /PageMode /UseOutlines >>\nendobj\n',
)
objects.set(
  2,
  `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count 5 >>\nendobj\n`,
)

for (let i = 0; i < pageObjectIds.length; i += 1) {
  const pageId = pageObjectIds[i]
  const contentId = contentObjectIds[i]
  objects.set(
    pageId,
    `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 13 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
  )
  const pageNo = i + 1
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 720 Td',
    `(${escapePdfString(`Sample PDF Page ${pageNo}`)}) Tj`,
    '0 -42 Td',
    '/F1 14 Tf',
    `(${escapePdfString(`This is real selectable text on page ${pageNo} of the PDF reader fixture.`)}) Tj`,
    '0 -24 Td',
    `(${escapePdfString(`Chapter ${pageNo <= 3 ? 'One' : 'Two'} content exercises rendering, text extraction, and page range parts.`)}) Tj`,
    'ET',
  ].join('\n')
  objects.set(contentId, streamObject(contentId, content))
}

objects.set(
  13,
  '13 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
)
objects.set(
  14,
  '14 0 obj\n<< /Type /Outlines /First 15 0 R /Last 16 0 R /Count 2 >>\nendobj\n',
)
objects.set(
  15,
  '15 0 obj\n<< /Title (Chapter One) /Parent 14 0 R /Next 16 0 R /Dest [3 0 R /Fit] >>\nendobj\n',
)
objects.set(
  16,
  '16 0 obj\n<< /Title (Chapter Two) /Parent 14 0 R /Prev 15 0 R /Dest [6 0 R /Fit] >>\nendobj\n',
)

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
const offsets = [0]
for (let id = 1; id <= 16; id += 1) {
  offsets[id] = Buffer.byteLength(pdf, 'latin1')
  pdf += objects.get(id)
}
const xrefOffset = Buffer.byteLength(pdf, 'latin1')
pdf += `xref\n0 17\n0000000000 65535 f \n`
for (let id = 1; id <= 16; id += 1) {
  pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size 17 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, pdf, 'latin1')
console.log(`Wrote ${outPath} (${Buffer.byteLength(pdf, 'latin1')} bytes)`)
