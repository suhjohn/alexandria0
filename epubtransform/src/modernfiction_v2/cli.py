"""
Command-line interface for modernfiction.

Usage:
    modernfiction transform <epub_file> [--prompt <text>] [--output <path>]
    modernfiction transform <epub_file> -p "Rewrite as a thriller"
    modernfiction transform <url> -o output.epub
"""

import argparse
import asyncio
import logging
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .transform import transform


def create_parser() -> argparse.ArgumentParser:
    """Create the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="modernfiction",
        description="Transform EPUB files using LLM-based text rewriting",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Transform command
    transform_parser = subparsers.add_parser(
        "transform",
        help="Transform an EPUB file",
        description="Transform an EPUB file by rewriting its paragraphs using an LLM",
    )
    transform_parser.add_argument(
        "epub_file",
        type=str,
        help="Path to the input EPUB file or URL to download",
    )
    transform_parser.add_argument(
        "-p",
        "--prompt",
        type=str,
        default="",
        help='Custom transformation prompt (default: "Rewrite in modern style")',
    )
    transform_parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output path (default: <input>.transformed.epub)",
    )
    transform_parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show detailed progress information",
    )

    return parser


def is_url(path: str) -> bool:
    """Check if the path is a URL."""
    return path.startswith("http://") or path.startswith("https://")


def download_epub(url: str) -> Path:
    """Download EPUB from URL to a temporary file."""
    print(f"Downloading from: {url}")

    # Create temp file
    temp_file = tempfile.NamedTemporaryFile(suffix=".epub", delete=False)
    temp_path = Path(temp_file.name)

    try:
        # Download with proper headers
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=60) as response:
            content = response.read()
            temp_file.write(content)
            temp_file.close()

        size_mb = temp_path.stat().st_size / 1024 / 1024
        print(f"Downloaded {size_mb:.2f} MB\n")
        return temp_path

    except Exception as e:
        temp_file.close()
        temp_path.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download EPUB: {e}")


async def run_transform(args: argparse.Namespace) -> int:
    """Run the transform command."""
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    input_source = args.epub_file
    is_remote = is_url(input_source)
    temp_file = None

    try:
        # Handle URL or local file
        if is_remote:
            # Download from URL
            epub_path = download_epub(input_source)
            temp_file = epub_path

            # Derive filename from URL if no output specified
            if not args.output:
                parsed_url = urlparse(input_source)
                url_filename = Path(parsed_url.path).stem
                if url_filename:
                    default_name = f"{url_filename}.transformed.epub"
                else:
                    default_name = "output.transformed.epub"
                output_path = Path(default_name)
            else:
                output_path = Path(args.output)
        else:
            # Local file
            epub_path = Path(input_source)

            # Validate input file exists
            if not epub_path.exists():
                print(f"Error: File not found: {epub_path}", file=sys.stderr)
                return 1

            if not epub_path.suffix.lower() == ".epub":
                print(f"Error: File must be an EPUB: {epub_path}", file=sys.stderr)
                return 1

            # Determine output path
            if args.output:
                output_path = Path(args.output)
            else:
                output_path = epub_path.with_stem(epub_path.stem + ".transformed")

        # Show info
        print(f"Transforming: {epub_path.name if is_remote else epub_path}")
        if args.prompt:
            print(f"Prompt: {args.prompt}")
        print(f"Output will be: {output_path}")
        print()

        # Run transform
        await transform(str(epub_path), prompt=args.prompt)

        # Check output was created
        expected_output = epub_path.with_stem(epub_path.stem + ".transformed")
        if expected_output.exists():
            # Move to desired output location if different
            if expected_output != output_path:
                expected_output.rename(output_path)

            size_mb = output_path.stat().st_size / 1024 / 1024
            print("\nSuccess! Transformed EPUB created:")
            print(f"  Path: {output_path}")
            print(f"  Size: {size_mb:.2f} MB")
            return 0
        else:
            print("\nError: Output file was not created", file=sys.stderr)
            return 1

    except FileNotFoundError as e:
        print(f"\nError: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"\nError during transformation: {e}", file=sys.stderr)
        if args.verbose:
            import traceback

            traceback.print_exc()
        return 1
    finally:
        # Clean up temp file if we downloaded one
        if temp_file and temp_file.exists():
            temp_file.unlink(missing_ok=True)


def main() -> int:
    """Main CLI entry point."""
    parser = create_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    if args.command == "transform":
        return asyncio.run(run_transform(args))

    return 0


if __name__ == "__main__":
    sys.exit(main())
