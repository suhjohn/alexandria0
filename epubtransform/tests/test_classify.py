from __future__ import annotations

from pathlib import Path

import pymupdf as fitz

from modernfiction_v2.classify import classify_pdf, render_cover_png


def _save_text_pdf(path: Path) -> None:
    doc = fitz.open()
    doc.set_metadata({"title": "  Test Title  ", "author": "  Test Author  "})
    text = (
        "This is a generated text-layer PDF page with enough searchable words "
        "to exceed the text detection threshold. "
    )
    for index in range(3):
        page = doc.new_page()
        page.insert_text((72, 72), f"Page {index + 1}. {text * 3}")
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


def _save_encrypted_pdf(path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "This text should not be readable without a password.")
    doc.save(
        path,
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw="owner-password",
        user_pw="user-password",
    )
    doc.close()


def test_classify_text_pdf_detects_text_layer_and_metadata(tmp_path: Path) -> None:
    pdf_path = tmp_path / "text.pdf"
    _save_text_pdf(pdf_path)

    result = classify_pdf(str(pdf_path))

    assert result == {
        "encrypted": False,
        "page_count": 3,
        "has_text_layer": True,
        "title": "Test Title",
        "author": "Test Author",
    }


def test_classify_image_only_pdf_has_no_text_layer(tmp_path: Path) -> None:
    pdf_path = tmp_path / "image-only.pdf"
    _save_image_only_pdf(pdf_path)

    result = classify_pdf(str(pdf_path))

    assert result["encrypted"] is False
    assert result["page_count"] == 3
    assert result["has_text_layer"] is False


def test_classify_encrypted_pdf(tmp_path: Path) -> None:
    pdf_path = tmp_path / "encrypted.pdf"
    _save_encrypted_pdf(pdf_path)

    result = classify_pdf(str(pdf_path))

    assert result["encrypted"] is True
    assert result["page_count"] == 0
    assert result["has_text_layer"] is False


def test_render_cover_png_returns_png_bytes(tmp_path: Path) -> None:
    pdf_path = tmp_path / "text.pdf"
    _save_text_pdf(pdf_path)

    png = render_cover_png(str(pdf_path))

    assert png is not None
    assert len(png) > 0
    assert png.startswith(b"\x89PNG")
