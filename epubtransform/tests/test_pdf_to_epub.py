from __future__ import annotations

import zipfile
from pathlib import Path

import pymupdf as fitz
import pytest
from lxml import etree

from modernfiction_v2.pdf_to_epub import build_epub_from_pdf
from modernfiction_v2.transform import transform


def _text_page(page: fitz.Page, text: str) -> None:
    page.insert_textbox(
        fitz.Rect(72, 72, 540, 720),
        text,
        fontsize=11,
    )


def _save_text_pdf(
    path: Path,
    *,
    page_texts: list[str],
    toc: list[list[int | str]] | None = None,
) -> None:
    doc = fitz.open()
    doc.set_metadata({"title": "  Outline Fixture  ", "author": "  Test Author  "})
    for text in page_texts:
        page = doc.new_page()
        _text_page(page, text)
    if toc:
        doc.set_toc(toc)
    doc.save(path)
    doc.close()


def _save_image_only_pdf(path: Path) -> None:
    doc = fitz.open()
    for _ in range(3):
        page = doc.new_page()
        page.draw_rect(
            fitz.Rect(72, 72, 320, 420),
            color=(0.1, 0.2, 0.8),
            fill=(0.8, 0.9, 1.0),
        )
    doc.save(path)
    doc.close()


def _fixture_text(label: str) -> str:
    return (
        f"{label} paragraph one has enough ordinary words to survive PDF extraction. "
        f"{label} paragraph one continues with more searchable text for the EPUB builder.\n\n"
        f"{label} paragraph two checks blank-line paragraph splitting and hard wraps.\n"
        "This continuation should be merged into the same paragraph rather than left as a line."
    )


def _rootfile_path(epub_path: Path) -> str:
    with zipfile.ZipFile(epub_path) as epub:
        container = etree.fromstring(epub.read("META-INF/container.xml"))
    return container.xpath("string(//*[local-name()='rootfile']/@full-path)")


def _chapter_files(epub_path: Path) -> list[str]:
    with zipfile.ZipFile(epub_path) as epub:
        return sorted(name for name in epub.namelist() if name.startswith("OEBPS/chapter_"))


def test_build_epub_from_pdf_uses_outline_and_writes_valid_epub(tmp_path: Path) -> None:
    pdf_path = tmp_path / "outline.pdf"
    epub_path = tmp_path / "outline.epub"
    _save_text_pdf(
        pdf_path,
        page_texts=[
            _fixture_text("Opening chapter"),
            _fixture_text("Opening chapter continued"),
            _fixture_text("Second chapter"),
            _fixture_text("Second chapter continued"),
        ],
        toc=[[1, "Chapter One", 1], [1, "Chapter Two", 3]],
    )

    build_epub_from_pdf(str(pdf_path), str(epub_path))

    with zipfile.ZipFile(epub_path) as epub:
        infos = epub.infolist()
        assert infos[0].filename == "mimetype"
        assert infos[0].compress_type == zipfile.ZIP_STORED
        assert epub.read("mimetype") == b"application/epub+zip"
        assert _rootfile_path(epub_path) == "OEBPS/content.opf"

        chapter_files = [name for name in epub.namelist() if name.startswith("OEBPS/chapter_")]
        assert len(chapter_files) >= 2

        chapter = etree.fromstring(epub.read("OEBPS/chapter_001.xhtml"))
        chapter_text = " ".join(chapter.xpath("//*[local-name()='p']/text()"))
        assert "Opening chapter paragraph one" in chapter_text
        assert "This continuation should be merged into the same paragraph" in chapter_text

        nav = etree.fromstring(epub.read("OEBPS/nav.xhtml"))
        nav_text = " ".join(nav.xpath("//*[local-name()='a']/text()"))
        assert "Chapter One" in nav_text
        assert "Chapter Two" in nav_text


def test_build_epub_from_pdf_chunks_pdf_without_outline(tmp_path: Path) -> None:
    pdf_path = tmp_path / "no-outline.pdf"
    epub_path = tmp_path / "no-outline.epub"
    _save_text_pdf(
        pdf_path,
        page_texts=[_fixture_text(f"Page {page_number}") for page_number in range(1, 21)],
    )

    build_epub_from_pdf(str(pdf_path), str(epub_path))

    assert len(_chapter_files(epub_path)) == 2
    with zipfile.ZipFile(epub_path) as epub:
        nav = etree.fromstring(epub.read("OEBPS/nav.xhtml"))
        nav_text = " ".join(nav.xpath("//*[local-name()='a']/text()"))
        assert "Pages 1\u201315" in nav_text
        assert "Pages 16\u201320" in nav_text


def test_build_epub_from_image_only_pdf_raises_value_error(tmp_path: Path) -> None:
    pdf_path = tmp_path / "image-only.pdf"
    epub_path = tmp_path / "image-only.epub"
    _save_image_only_pdf(pdf_path)

    with pytest.raises(ValueError, match="no extractable text"):
        build_epub_from_pdf(str(pdf_path), str(epub_path))


@pytest.mark.asyncio
async def test_transform_accepts_generated_epub_with_identity_llm(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    epub_path = tmp_path / "converted.epub"
    _save_text_pdf(
        pdf_path,
        page_texts=[_fixture_text("Transform sanity"), _fixture_text("Transform sanity two")],
    )
    build_epub_from_pdf(str(pdf_path), str(epub_path))

    async def identity_replace(html: str, prompt: str = "") -> str:
        return html

    monkeypatch.setattr("modernfiction_v2.transform.replace_html", identity_replace)

    await transform(str(epub_path))

    out_path = epub_path.with_name("converted.transformed.epub")
    assert out_path.exists()
    with zipfile.ZipFile(out_path) as epub:
        assert "OEBPS/chapter_001.xhtml" in epub.namelist()
