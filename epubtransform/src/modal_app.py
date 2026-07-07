"""
Modal deployment configuration for ModernFiction API.

Deploy with: modal deploy src/modal_app.py
Run locally: modal serve src/modal_app.py
"""

import asyncio
import os
import tempfile
from pathlib import Path

import boto3
import modal
from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from src.modernfiction_v2.classify import classify_pdf, render_cover_png
from src.modernfiction_v2.transform import transform

app = modal.App("modernfiction-api")
secrets = [modal.Secret.from_name("alexandria0-secret")]

# Modal 1.0 requires explicit inclusion of local Python source.
image = modal.Image.debian_slim(python_version="3.12").uv_sync().add_local_python_source("src")


def _r2_client() -> boto3.client:
    account_id = os.getenv("R2_ACCOUNT_ID")
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    endpoint = os.getenv("S3_ENDPOINT_URL")
    region = os.getenv("S3_REGION") or os.getenv("R2_REGION", "auto")
    if not endpoint and not account_id:
        raise RuntimeError("Missing R2_ACCOUNT_ID or S3_ENDPOINT_URL")
    if not access_key or not secret_key:
        raise RuntimeError("Missing R2 credentials; set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY")
    if not endpoint:
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    force_path_style = os.getenv("S3_FORCE_PATH_STYLE", "").strip().lower() in {
        "1",
        "t",
        "true",
        "y",
        "yes",
        "on",
    }
    config = Config(s3={"addressing_style": "path"}) if force_path_style else None
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=config,
    )


def _r2_bucket() -> str:
    bucket = os.getenv("R2_BUCKET_NAME")
    if not bucket:
        raise RuntimeError("Missing R2_BUCKET_NAME")
    return bucket


def _derive_dest_key(source_key: str) -> str:
    if source_key.lower().endswith(".epub"):
        return source_key[: -len(".epub")] + "_modernify.epub"
    return source_key + "_modernify.epub"


class TransformRequest(BaseModel):
    source_key: str
    dest_key: str | None = None
    prompt: str = ""


class TransformResponse(BaseModel):
    call_id: str
    dest_key: str
    url: str | None = None


class TransformStatusRequest(BaseModel):
    dest_key: str


class TransformStatusResponse(BaseModel):
    ready: bool


class ClassifyRequest(BaseModel):
    source_key: str
    cover_key: str | None = None


class ClassifyResponse(BaseModel):
    encrypted: bool
    page_count: int
    has_text_layer: bool
    title: str | None = None
    author: str | None = None
    cover_uploaded: bool


@app.function(image=image, timeout=60 * 60, secrets=secrets)
def transform_epub(source_key: str, dest_key: str | None = None, prompt: str = "") -> str:
    bucket = _r2_bucket()
    client = _r2_client()
    resolved_dest = dest_key or _derive_dest_key(source_key)

    with tempfile.TemporaryDirectory() as td:
        input_path = Path(td) / "input.epub"
        client.download_file(bucket, source_key, str(input_path))

        asyncio.run(transform(str(input_path), prompt=prompt))
        output_path = input_path.with_name(input_path.stem + ".transformed.epub")

        if not output_path.exists():
            raise RuntimeError("Transform did not produce an output EPUB")

        client.upload_file(str(output_path), bucket, resolved_dest)

    return resolved_dest


@app.function(image=image, secrets=secrets)
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    api = FastAPI()

    def _require_api_key(x_api_key: str | None) -> None:
        expected = os.getenv("API_SECRET_KEY")
        if not expected:
            raise HTTPException(status_code=500, detail="API secret not configured")
        if not x_api_key or x_api_key != expected:
            raise HTTPException(status_code=401, detail="Unauthorized")

    @api.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.post("/transform", response_model=TransformResponse)
    async def start_transform(
        req: TransformRequest, x_api_key: str | None = Header(default=None)
    ) -> TransformResponse:
        _require_api_key(x_api_key)
        if not req.source_key.lower().endswith(".epub"):
            raise HTTPException(status_code=422, detail="Transforms only support EPUB sources")

        dest_key = req.dest_key or _derive_dest_key(req.source_key)
        call = transform_epub.spawn(req.source_key, dest_key, req.prompt)
        public_base = os.getenv("R2_PUBLIC_URL", "").rstrip("/")
        url = f"{public_base}/{dest_key}" if public_base else None
        return TransformResponse(call_id=call.object_id, dest_key=dest_key, url=url)

    @api.post("/transform/status", response_model=TransformStatusResponse)
    async def transform_status(
        req: TransformStatusRequest, x_api_key: str | None = Header(default=None)
    ) -> TransformStatusResponse:
        _require_api_key(x_api_key)
        bucket = _r2_bucket()
        client = _r2_client()
        try:
            client.head_object(Bucket=bucket, Key=req.dest_key)
            return TransformStatusResponse(ready=True)
        except Exception:
            return TransformStatusResponse(ready=False)

    @api.post("/classify", response_model=ClassifyResponse)
    async def classify(
        req: ClassifyRequest, x_api_key: str | None = Header(default=None)
    ) -> ClassifyResponse:
        _require_api_key(x_api_key)
        bucket = _r2_bucket()
        client = _r2_client()

        with tempfile.TemporaryDirectory() as td:
            input_path = Path(td) / "source.pdf"
            try:
                client.download_file(bucket, req.source_key, str(input_path))
            except ClientError as exc:
                error_code = exc.response.get("Error", {}).get("Code")
                if error_code in {"404", "NoSuchKey", "NotFound"}:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Source object not found: {req.source_key}",
                    ) from exc
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to download source object: {req.source_key}",
                ) from exc

            try:
                result = classify_pdf(str(input_path))
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="Unable to parse PDF") from exc

            cover_uploaded = False
            if req.cover_key and not result["encrypted"]:
                cover_png = render_cover_png(str(input_path))
                if cover_png:
                    try:
                        client.put_object(
                            Bucket=bucket,
                            Key=req.cover_key,
                            Body=cover_png,
                            ContentType="image/png",
                        )
                        cover_uploaded = True
                    except Exception:
                        cover_uploaded = False

        return ClassifyResponse(**result, cover_uploaded=cover_uploaded)

    return api
