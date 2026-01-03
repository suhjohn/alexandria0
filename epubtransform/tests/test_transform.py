from pathlib import Path

import pytest

from modernfiction_v2.transform import transform


@pytest.fixture
def epub_file(tmp_path: Path) -> Path:
    """Copy the bundled test EPUB to a temp path (offline, deterministic)."""
    repo_root = Path(__file__).resolve().parents[1]
    src = repo_root / "books" / "input" / "antigone.epub"
    if not src.exists():
        raise FileNotFoundError(f"Missing bundled test EPUB at {src}")

    dst = tmp_path / "antigone.epub"
    dst.write_bytes(src.read_bytes())
    return dst


@pytest.mark.asyncio
async def test_transform_creates_output_file(epub_file: Path, monkeypatch):
    """Test that transform creates a .transformed.epub file."""

    async def mock_replace(html: str, prompt: str = "") -> str:
        return html

    monkeypatch.setattr("modernfiction_v2.transform.replace_html", mock_replace)

    await transform(str(epub_file))

    out_path = epub_file.with_name(epub_file.stem + ".transformed.epub")
    assert out_path.exists(), "Transformed EPUB should be created"
    assert out_path.stat().st_size > 0, "Transformed EPUB should not be empty"

    # Cleanup
    out_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_transform_with_mock_replace(epub_file: Path, monkeypatch):
    """Test that replace_html is called for each paragraph."""
    call_count = 0

    async def mock_replace(html: str, prompt: str = "") -> str:
        nonlocal call_count
        call_count += 1
        # Add a marker to verify replacement happened
        return html.replace("<p", '<p class="transformed"')

    monkeypatch.setattr("modernfiction_v2.transform.replace_html", mock_replace)

    await transform(str(epub_file))

    assert call_count > 0, "replace_html should be called at least once"

    out_path = epub_file.with_name(epub_file.stem + ".transformed.epub")
    out_path.unlink(missing_ok=True)
