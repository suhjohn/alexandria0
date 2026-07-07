from __future__ import annotations

import math
from collections.abc import Sequence

import pymupdf as fitz


def _clean_metadata_value(value: str | None) -> str | None:
    if not value:
        return None
    stripped = value.strip()
    return stripped or None


def _read_metadata(doc: fitz.Document) -> dict:
    try:
        return doc.metadata or {}
    except Exception:
        return {}


def _sample_page_indices(page_count: int, sample_size: int = 10) -> Sequence[int]:
    if page_count <= sample_size:
        return range(page_count)
    return [round(index * (page_count - 1) / (sample_size - 1)) for index in range(sample_size)]


def classify_pdf(path: str) -> dict:
    try:
        doc = fitz.open(path)
    except Exception as exc:
        raise ValueError("Unable to open PDF") from exc

    try:
        metadata = _read_metadata(doc)
        title = _clean_metadata_value(metadata.get("title"))
        author = _clean_metadata_value(metadata.get("author"))

        if doc.needs_pass:
            return {
                "encrypted": True,
                "page_count": 0,
                "has_text_layer": False,
                "title": title,
                "author": author,
            }

        page_count = doc.page_count
        sampled_pages = list(_sample_page_indices(page_count))
        pages_with_text = 0

        for page_index in sampled_pages:
            try:
                text = doc.load_page(page_index).get_text("text")
            except Exception:
                continue

            non_whitespace_chars = sum(1 for char in text if not char.isspace())
            if non_whitespace_chars > 50:
                pages_with_text += 1

        threshold = math.ceil(len(sampled_pages) / 2)
        has_text_layer = bool(sampled_pages) and pages_with_text >= threshold

        return {
            "encrypted": False,
            "page_count": page_count,
            "has_text_layer": has_text_layer,
            "title": title,
            "author": author,
        }
    finally:
        doc.close()


def render_cover_png(path: str, max_dimension: int = 1600) -> bytes | None:
    try:
        doc = fitz.open(path)
    except Exception:
        return None

    try:
        if doc.needs_pass or doc.page_count < 1:
            return None

        page = doc.load_page(0)
        rect = page.rect
        longest_side = max(rect.width, rect.height)
        scale = max_dimension / longest_side if longest_side > 0 else 1
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        return pix.tobytes("png")
    except Exception:
        return None
    finally:
        doc.close()
