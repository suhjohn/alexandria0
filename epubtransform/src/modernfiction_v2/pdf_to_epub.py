from __future__ import annotations

import re
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf as fitz


@dataclass(frozen=True)
class Chapter:
    title: str
    start_page: int
    end_page: int
    paragraphs: list[str]


def _clean_metadata_value(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    stripped = value.strip()
    return stripped or fallback


def _metadata(doc: fitz.Document) -> tuple[str, str]:
    try:
        metadata = doc.metadata or {}
    except Exception:
        metadata = {}
    return (
        _clean_metadata_value(metadata.get("title"), "Untitled"),
        _clean_metadata_value(metadata.get("author"), "Unknown"),
    )


def _chapter_ranges_from_outline(doc: fitz.Document) -> list[tuple[str, int, int]]:
    top_level_entries: list[tuple[str, int]] = []

    try:
        toc = doc.get_toc()
    except Exception:
        toc = []

    for index, entry in enumerate(toc, start=1):
        if len(entry) < 3:
            continue
        level, title, page_number = entry[:3]
        if level != 1 or not isinstance(page_number, int):
            continue
        if page_number < 1 or page_number > doc.page_count:
            continue
        top_level_entries.append((str(title).strip() or f"Chapter {index}", page_number - 1))

    if not top_level_entries:
        return _chapter_ranges_by_page_count(doc.page_count)

    chapters: list[tuple[str, int, int]] = []
    first_page = top_level_entries[0][1]
    if first_page > 0:
        chapters.append(("Front Matter", 0, first_page))

    for index, (title, start_page) in enumerate(top_level_entries):
        end_page = (
            top_level_entries[index + 1][1]
            if index + 1 < len(top_level_entries)
            else doc.page_count
        )
        if start_page < end_page:
            chapters.append((title, start_page, end_page))

    return chapters


def _chapter_ranges_by_page_count(page_count: int) -> list[tuple[str, int, int]]:
    ranges: list[tuple[str, int, int]] = []
    for start_page in range(0, page_count, 15):
        end_page = min(start_page + 15, page_count)
        ranges.append((f"Pages {start_page + 1}\u2013{end_page}", start_page, end_page))
    return ranges


def _paragraphs_from_block(text: str) -> list[str]:
    chunks = re.split(r"\n\s*\n+", text.replace("\r\n", "\n").replace("\r", "\n"))
    paragraphs: list[str] = []
    for chunk in chunks:
        lines = [line.strip() for line in chunk.splitlines()]
        paragraph = " ".join(line for line in lines if line)
        paragraph = re.sub(r"\s+", " ", paragraph).strip()
        if paragraph:
            paragraphs.append(paragraph)
    return paragraphs


def _paragraphs_from_page(page: fitz.Page) -> list[str]:
    try:
        blocks = page.get_text("blocks")
    except Exception:
        return []

    text_blocks = []
    for block in blocks:
        if len(block) < 5:
            continue
        block_type = block[6] if len(block) > 6 else 0
        if block_type != 0:
            continue
        text = str(block[4])
        if text.strip():
            text_blocks.append((float(block[1]), float(block[0]), text))

    paragraphs: list[str] = []
    for _, _, text in sorted(text_blocks):
        paragraphs.extend(_paragraphs_from_block(text))
    return paragraphs


def _chapter_xhtml(title: str, paragraphs: list[str]) -> str:
    escaped_title = escape(title)
    body = "\n".join(f"    <p>{escape(paragraph)}</p>" for paragraph in paragraphs)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>{escaped_title}</title>
  </head>
  <body>
    <h1>{escaped_title}</h1>
{body}
  </body>
</html>
"""


def _nav_xhtml(book_title: str, chapters: list[Chapter]) -> str:
    entries = "\n".join(
        f'      <li><a href="chapter_{index:03d}.xhtml">{escape(chapter.title)}</a></li>'
        for index, chapter in enumerate(chapters, start=1)
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>{escape(book_title)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
{entries}
      </ol>
    </nav>
  </body>
</html>
"""


def _content_opf(book_title: str, author: str, chapters: list[Chapter]) -> str:
    manifest_items = "\n".join(
        f'    <item id="chapter-{index:03d}" href="chapter_{index:03d}.xhtml" '
        'media-type="application/xhtml+xml"/>'
        for index in range(1, len(chapters) + 1)
    )
    spine_items = "\n".join(
        f'    <itemref idref="chapter-{index:03d}"/>'
        for index in range(1, len(chapters) + 1)
    )
    modified = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    identifier = f"urn:uuid:{uuid.uuid4()}"

    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{identifier}</dc:identifier>
    <dc:title>{escape(book_title)}</dc:title>
    <dc:creator>{escape(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
{manifest_items}
  </manifest>
  <spine>
{spine_items}
  </spine>
</package>
"""


def _container_xml() -> str:
    return """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _write_epub(epub_path: Path, title: str, author: str, chapters: list[Chapter]) -> None:
    epub_path.parent.mkdir(parents=True, exist_ok=True)
    if epub_path.exists():
        epub_path.unlink()

    with zipfile.ZipFile(epub_path, "w") as zout:
        zout.writestr(
            "mimetype",
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        zout.writestr(
            "META-INF/container.xml",
            _container_xml(),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        zout.writestr(
            "OEBPS/content.opf",
            _content_opf(title, author, chapters),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        zout.writestr(
            "OEBPS/nav.xhtml",
            _nav_xhtml(title, chapters),
            compress_type=zipfile.ZIP_DEFLATED,
        )

        for index, chapter in enumerate(chapters, start=1):
            zout.writestr(
                f"OEBPS/chapter_{index:03d}.xhtml",
                _chapter_xhtml(chapter.title, chapter.paragraphs),
                compress_type=zipfile.ZIP_DEFLATED,
            )


def build_epub_from_pdf(pdf_path: str, epub_path: str) -> None:
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        raise ValueError("Unable to open PDF") from exc

    try:
        if doc.needs_pass:
            raise ValueError("PDF is encrypted or password-protected")

        total_text_chars = 0
        page_paragraphs: list[list[str]] = []
        for page_index in range(doc.page_count):
            paragraphs = _paragraphs_from_page(doc.load_page(page_index))
            page_paragraphs.append(paragraphs)
            total_text_chars += sum(
                1 for paragraph in paragraphs for char in paragraph if not char.isspace()
            )

        if total_text_chars < 200:
            raise ValueError("PDF yielded no extractable text; text layer is missing or too sparse")

        title, author = _metadata(doc)
        chapters: list[Chapter] = []
        for chapter_title, start_page, end_page in _chapter_ranges_from_outline(doc):
            paragraphs: list[str] = []
            for page_index in range(start_page, end_page):
                paragraphs.extend(page_paragraphs[page_index])
            if paragraphs:
                chapters.append(
                    Chapter(
                        title=chapter_title,
                        start_page=start_page,
                        end_page=end_page,
                        paragraphs=paragraphs,
                    )
                )

        if not chapters:
            raise ValueError("PDF yielded no extractable text; no text chapters could be built")

        _write_epub(Path(epub_path), title, author, chapters)
    finally:
        doc.close()
