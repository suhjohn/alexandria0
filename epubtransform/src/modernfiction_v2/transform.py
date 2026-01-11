import asyncio
import logging
import os
import re
import tempfile
import zipfile
from pathlib import Path

from litellm import acompletion
from lxml import etree

logger = logging.getLogger(__name__)

MAX_LLM_TOKENS = 1024 * 64
# Leave headroom for system/prompt tokens and model overhead.
MAX_LLM_TOKENS_PER_TEXT_CHUNK = MAX_LLM_TOKENS - 4096
MAX_HTML_BATCH_TOKENS = 4096
# Wrapper + prompt overhead headroom when batching multiple <p> tags.
MAX_HTML_BATCH_TOKENS_EFFECTIVE = MAX_HTML_BATCH_TOKENS - 256


def _estimate_tokens(text: str) -> int:
    """
    Rough, dependency-free token estimate.

    We intentionally overestimate slightly to stay under model limits without pulling in a
    tokenizer.
    """
    if not text:
        return 0
    return (len(text) + 3) // 4


def _iter_sentenceish_segments(text: str) -> list[str]:
    """
    Split text into sentence-ish segments, preserving whitespace.

    This is a best-effort heuristic (no NLP dependency). It aims to avoid splitting mid-sentence.
    """
    if not text:
        return []
    # Non-greedy capture up to punctuation + trailing whitespace, or end of string.
    pat = re.compile(r".*?(?:[.!?]+(?:\s+|$)|$)", re.DOTALL)
    segs = [m.group(0) for m in pat.finditer(text) if m.group(0)]
    return segs if segs else [text]


def _chunk_text_by_sentences(text: str, *, max_tokens: int) -> list[str]:
    """
    Chunk text into pieces under `max_tokens`, preferring sentence boundaries.

    If a single sentence-ish segment exceeds the limit, we fall back to char-based chunking.
    """
    if not text:
        return []

    max_tokens = max(1, max_tokens)
    segments = _iter_sentenceish_segments(text)

    out: list[str] = []
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf:
            out.append(buf)
            buf = ""

    for seg in segments:
        if _estimate_tokens(seg) > max_tokens:
            # Flush what we already have, then hard-split this segment.
            flush()
            max_chars = max_tokens * 4
            s = seg
            while s:
                if len(s) <= max_chars:
                    out.append(s)
                    break
                cut = s.rfind(" ", 0, max_chars)
                if cut < max_chars * 0.5:
                    cut = max_chars
                out.append(s[:cut])
                s = s[cut:]
            continue

        candidate = f"{buf}{seg}" if buf else seg
        if _estimate_tokens(candidate) <= max_tokens:
            buf = candidate
        else:
            flush()
            buf = seg

    flush()
    return out


async def replace_text(text: str, prompt: str = "") -> str:
    """
    Rewrite plain text (no HTML expected).

    Used as a safe fallback for oversized <p> elements by rewriting their text nodes
    while preserving the original tag structure.
    """
    if not prompt:
        prompt = (
            "Rewrite this text in a more modern, engaging style while preserving the original "
            "meaning."
        )

    system_message = f"{prompt}\n\nIMPORTANT: Return ONLY the transformed text."

    try:
        response = await acompletion(
            model="gemini/gemini-3-flash-preview",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": text},
            ],
        )
        transformed = response.choices[0].message.content.strip()
        return transformed if transformed else text
    except Exception as e:
        logger.warning("Failed to transform text; keeping original: %s", e)
        return text


async def _rewrite_paragraph_text_nodes_in_place(
    p: etree._Element,
    *,
    prompt: str,
    llm_semaphore: asyncio.Semaphore,
) -> None:
    """
    Rewrite a <p> without ever creating extra <p> elements.

    We rewrite only `.text` and descendant `.tail` strings, leaving all tags intact.
    This avoids introducing new paragraph breaks/newlines in the rendered EPUB.
    """

    async def _bounded_replace_text(text: str) -> str:
        async with llm_semaphore:
            return await replace_text(text, prompt)

    async def _rewrite_text_value(value: str) -> str:
        if not value or not value.strip():
            return value
        chunks = _chunk_text_by_sentences(value, max_tokens=MAX_LLM_TOKENS_PER_TEXT_CHUNK)
        rewritten_parts: list[str] = []
        for chunk in chunks:
            rewritten_parts.append(await _bounded_replace_text(chunk))
        return "".join(rewritten_parts)

    # Rewrite p.text
    if p.text is not None:
        p.text = await _rewrite_text_value(p.text)

    # Rewrite descendant tails/texts (but never p.tail, which is outside the paragraph).
    for el in p.iterdescendants():
        if el.text is not None:
            el.text = await _rewrite_text_value(el.text)
        if el.tail is not None:
            el.tail = await _rewrite_text_value(el.tail)


async def replace_html(html: str, prompt: str = "") -> str:
    if not prompt:
        prompt = (
            "Rewrite this paragraph in a more modern, engaging style while preserving the original "
            "meaning and structure."
        )

    system_message = (
        f"{prompt}\n\nIMPORTANT: Return ONLY the transformed HTML. Preserve all HTML tags and "
        "structure. If the input contains multiple <p> elements, return the same number of <p> "
        "elements in the same order (do not merge or split paragraphs)."
    )

    try:
        response = await acompletion(
            model="gemini/gemini-3-flash-preview",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": html},
            ],
        )

        transformed = response.choices[0].message.content.strip()
        logger.info("Transformed paragraph: %s", transformed)
        return transformed if transformed else html
    except Exception as e:
        logger.warning("Failed to transform paragraph; keeping original: %s", e)
        return html


async def _process_html_file(
    html_path: Path,
    *,
    prompt: str,
    llm_semaphore: asyncio.Semaphore,
) -> int:
    """
    Parse a single XHTML/HTML file, rewrite <p> tags via the LLM, and write it back.

    Concurrency notes:
    - The file itself is processed in an asyncio task (so multiple files can be in-flight).
    - LLM calls are globally bounded by `llm_semaphore` to avoid rate-limit storms.
    """
    parser = etree.XMLParser(recover=True)
    try:
        doc = etree.parse(str(html_path), parser)
    except Exception:
        logger.debug("Skipping unreadable HTML file: %s", html_path)
        return 0

    ps = doc.xpath("//*[local-name()='body']//*[local-name()='p']")
    if not ps:
        return 0

    # Phase 1: handle oversized paragraphs safely (no new <p> tags).
    normal_ps: list[etree._Element] = []
    for p in ps:
        p_html = etree.tostring(p, encoding="unicode")
        p_tokens = _estimate_tokens(p_html)
        if p_tokens > MAX_LLM_TOKENS:
            logger.info(
                "Oversized <p> (~%d tokens) in %s; rewriting text nodes in chunks (no new <p>).",
                p_tokens,
                html_path,
            )
            await _rewrite_paragraph_text_nodes_in_place(
                p,
                prompt=prompt,
                llm_semaphore=llm_semaphore,
            )
        else:
            normal_ps.append(p)

    def _make_batches(paragraphs: list[etree._Element]) -> list[list[etree._Element]]:
        batches: list[list[etree._Element]] = []
        cur: list[etree._Element] = []
        cur_tokens = 0

        # Account for wrapper element tokens very conservatively.
        wrapper_tokens = _estimate_tokens("<div></div>")

        for p in paragraphs:
            p_html = etree.tostring(p, encoding="unicode")
            p_tokens = _estimate_tokens(p_html)

            # If a single paragraph doesn't fit in the batch cap, just treat it as its own batch.
            # (It'll still be under MAX_LLM_TOKENS from the filter above.)
            if p_tokens + wrapper_tokens > MAX_HTML_BATCH_TOKENS_EFFECTIVE:
                if cur:
                    batches.append(cur)
                    cur = []
                    cur_tokens = 0
                batches.append([p])
                continue

            proposed = cur_tokens + p_tokens
            if cur and proposed + wrapper_tokens > MAX_HTML_BATCH_TOKENS_EFFECTIVE:
                batches.append(cur)
                cur = [p]
                cur_tokens = p_tokens
            else:
                cur.append(p)
                cur_tokens = proposed

        if cur:
            batches.append(cur)
        return batches

    batches = _make_batches(normal_ps)
    if batches:
        logger.info(
            "Batching %d paragraphs into %d LLM calls (max ~%d tokens/call).",
            len(normal_ps),
            len(batches),
            MAX_HTML_BATCH_TOKENS,
        )

    def _clean_llm_html(raw: str) -> str:
        """
        Best-effort cleanup for LLM outputs that may include code fences or extra prose.

        We only ever want HTML/XML here.
        """
        text = (raw or "").strip()
        if not text:
            return ""

        if text.startswith("```"):
            lines = text.splitlines()
            if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].startswith("```"):
                text = "\n".join(lines[1:-1]).strip()

        # If the model returned prose + HTML, slice to the first/last tag.
        if not text.lstrip().startswith("<"):
            start = text.find("<")
            end = text.rfind(">")
            if 0 <= start < end:
                text = text[start : end + 1].strip()

        return text

    def _safe_parse_root(raw: str) -> etree._Element | None:
        cleaned = _clean_llm_html(raw)
        if not cleaned:
            return None
        try:
            root = etree.fromstring(cleaned, parser)
        except Exception:
            return None
        return root if root is not None else None

    async def _process_batch(
        batch: list[etree._Element],
    ) -> tuple[list[etree._Element], list[etree._Element] | None]:
        """
        Returns (original_ps, new_ps) where new_ps is None when we should fall back.
        """
        batch_htmls = [etree.tostring(p, encoding="unicode") for p in batch]
        wrapped_in = f"<div>{''.join(batch_htmls)}</div>"

        async with llm_semaphore:
            wrapped_out = await replace_html(wrapped_in, prompt)

        out_root = _safe_parse_root(wrapped_out)
        if out_root is None:
            return (batch, None)

        out_ps = out_root.xpath(".//*[local-name()='p']")
        if len(out_ps) != len(batch):
            return (batch, None)

        return (batch, [p for p in out_ps])

    async def _process_single(p: etree._Element) -> tuple[etree._Element, etree._Element | None]:
        p_html = etree.tostring(p, encoding="unicode")
        async with llm_semaphore:
            new_html = await replace_html(p_html, prompt)
        frag = _safe_parse_root(new_html)
        return (p, frag)

    # Phase 2: run batch calls concurrently, then apply replacements in a stable order.
    batch_results = await asyncio.gather(*(_process_batch(b) for b in batches))
    fallbacks: list[etree._Element] = []

    for orig_ps, new_ps in batch_results:
        if new_ps is None:
            fallbacks.extend(orig_ps)
            continue
        for orig, new in zip(orig_ps, new_ps, strict=False):
            try:
                orig.getparent().replace(orig, new)
            except Exception:
                pass

    if fallbacks:
        logger.info(
            "Falling back to per-paragraph calls for %d paragraphs due to malformed/mismatched "
            "batch output.",
            len(fallbacks),
        )
        single_results = await asyncio.gather(*(_process_single(p) for p in fallbacks))
        for orig, frag in single_results:
            if frag is None:
                continue
            try:
                orig.getparent().replace(orig, frag)
            except Exception:
                pass

    html_path.write_bytes(etree.tostring(doc, encoding="utf-8", xml_declaration=True))
    return len(ps)


async def transform(filename: str, prompt: str = "") -> None:
    in_path = Path(filename)
    if not in_path.exists():
        raise FileNotFoundError(in_path)

    out_path = in_path.with_name(in_path.stem + ".transformed.epub")
    logger.info("Transforming EPUB: %s -> %s", in_path, out_path)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)

        # Extract EPUB
        with zipfile.ZipFile(in_path, "r") as zin:
            zin.extractall(root)

        # Locate OPF via container.xml
        container_path = root / "META-INF" / "container.xml"
        if not container_path.exists():
            raise RuntimeError("Not a valid EPUB: META-INF/container.xml missing")

        opf_rel = etree.parse(str(container_path)).xpath("//*[local-name()='rootfile']/@full-path")[
            0
        ]
        opf_path = root / opf_rel
        opf_dir = opf_path.parent

        # Find all XHTML/HTML files
        html_files = list(opf_dir.rglob("*.xhtml")) + list(opf_dir.rglob("*.html"))
        logger.info("Found %d HTML/XHTML files under %s", len(html_files), opf_dir)

        # Process HTML files concurrently, but keep concurrency bounded to avoid
        # holding too many parsed documents in memory at once.
        file_concurrency = max(1, min(8, (os.cpu_count() or 2) * 2))
        llm_concurrency = 16
        logger.info(
            "Concurrency: file_concurrency=%d, llm_concurrency=%d",
            file_concurrency,
            llm_concurrency,
        )
        file_semaphore = asyncio.Semaphore(file_concurrency)
        llm_semaphore = asyncio.Semaphore(llm_concurrency)
        progress_lock = asyncio.Lock()
        processed_files = 0
        processed_paragraphs = 0
        total_files = len(html_files)

        async def _bounded_process(html_path: Path) -> None:
            nonlocal processed_files, processed_paragraphs
            async with file_semaphore:
                para_count = await _process_html_file(
                    html_path, prompt=prompt, llm_semaphore=llm_semaphore
                )

            async with progress_lock:
                processed_files += 1
                processed_paragraphs += para_count
                if processed_files in (1, total_files) or processed_files % 10 == 0:
                    logger.info(
                        "Progress: %d/%d files, %d paragraphs transformed",
                        processed_files,
                        total_files,
                        processed_paragraphs,
                    )

        if html_files:
            await asyncio.gather(*(_bounded_process(p) for p in html_files))
        logger.info(
            "HTML pass complete: %d/%d files processed; %d paragraphs transformed",
            processed_files,
            total_files,
            processed_paragraphs,
        )

        # Ensure mimetype exists
        mimetype_path = root / "mimetype"
        if not mimetype_path.exists():
            mimetype_path.write_text("application/epub+zip", encoding="utf-8")

        # Rebuild EPUB (mimetype first, uncompressed)
        if out_path.exists():
            out_path.unlink()

        with zipfile.ZipFile(out_path, "w") as zout:
            zout.write(mimetype_path, "mimetype", compress_type=zipfile.ZIP_STORED)
            for f in sorted(root.rglob("*")):
                if f.is_file() and f.name != "mimetype":
                    rel = f.relative_to(root).as_posix()
                    if rel.startswith("__MACOSX/") or rel.endswith(".DS_Store"):
                        continue
                    zout.write(f, rel, compress_type=zipfile.ZIP_DEFLATED)

    print(f"Transformed EPUB written to {out_path}")
