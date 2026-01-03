from __future__ import annotations

from modernfiction_v2.gutenberg import (
    DownloadLink,
    parse_ebook_page,
    parse_top_ebook_ids,
    pick_best_download_link,
)


def test_parse_top_ebook_ids_limits_and_dedupes() -> None:
    html = b"""
    <html><body>
      <h2>Top 100 EBooks yesterday</h2>
      <ol>
        <li><a href="/ebooks/1342">Pride and Prejudice</a></li>
        <li><a href="/ebooks/84">Frankenstein</a></li>
        <li><a href="/ebooks/1342">Pride and Prejudice (duplicate)</a></li>
      </ol>
    </body></html>
    """
    assert parse_top_ebook_ids(html, limit=10) == [1342, 84]
    assert parse_top_ebook_ids(html, limit=1) == [1342]


def test_parse_ebook_page_extracts_metadata_and_links() -> None:
    ebook_id = 1342
    html = b"""
    <html><head><title>Pride and Prejudice by Jane Austen - Project Gutenberg</title></head>
    <body>
      <h1>Pride and Prejudice</h1>
      <table class="bibrec">
        <tr><th>Author</th><td><a>Jane Austen</a></td></tr>
        <tr><th>Language</th><td><a>English</a></td></tr>
        <tr><th>Subject</th><td><a>Love stories</a> <a>England -- Fiction</a></td></tr>
        <tr><th>Bookshelf</th><td><a>Best Books Ever Listings</a></td></tr>
        <tr><th>LoCC</th><td><a>PR</a></td></tr>
        <tr><th>Release Date</th><td>June 1, 1998 [eBook #1342]</td></tr>
      </table>
      <table class="files">
        <tr><td><a href="/ebooks/1342.epub.noimages">EPUB (no images)</a></td></tr>
        <tr><td><a href="/ebooks/1342.epub.images">EPUB (with images)</a></td></tr>
        <tr><td><a href="/files/1342/1342-0.txt">Plain Text UTF-8</a></td></tr>
      </table>
    </body></html>
    """
    md, links = parse_ebook_page(html, ebook_id=ebook_id)
    assert md.ebook_id == 1342
    assert md.title == "Pride and Prejudice"
    assert md.authors == ["Jane Austen"]
    assert md.language == "English"
    assert "Love stories" in md.subjects
    assert md.bookshelves == ["Best Books Ever Listings"]
    assert md.locc == ["PR"]
    assert md.release_date is not None

    assert any(l.url.endswith("/ebooks/1342.epub.noimages") for l in links)
    assert any("Plain Text" in l.label for l in links)


def test_pick_best_download_link_prefers_epub_no_images() -> None:
    links = [
        DownloadLink(label="Plain Text UTF-8", url="https://www.gutenberg.org/files/1/1-0.txt"),
        DownloadLink(
            label="EPUB (with images)", url="https://www.gutenberg.org/ebooks/1.epub.images"
        ),
        DownloadLink(
            label="EPUB (no images)", url="https://www.gutenberg.org/ebooks/1.epub.noimages"
        ),
    ]
    best = pick_best_download_link(links, preferred_formats=["epub", "txt"])
    assert best is not None
    assert best.label == "EPUB (no images)"


def test_pick_best_download_link_can_prefer_txt() -> None:
    links = [
        DownloadLink(
            label="EPUB (no images)", url="https://www.gutenberg.org/ebooks/1.epub.noimages"
        ),
        DownloadLink(label="Plain Text UTF-8", url="https://www.gutenberg.org/files/1/1-0.txt"),
    ]
    best = pick_best_download_link(links, preferred_formats=["txt"])
    assert best is not None
    assert "Plain Text" in best.label
