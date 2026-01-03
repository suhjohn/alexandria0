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
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from src.modernfiction_v2.transform import transform

app = modal.App("modernfiction-api")
secrets = [modal.Secret.from_name("alexandria0-secret")]

# Modal 1.0 requires explicit inclusion of local Python source.
image = modal.Image.debian_slim(python_version="3.12").uv_sync().add_local_python_source("src")


def _r2_client() -> boto3.client:
    account_id = os.getenv("R2_ACCOUNT_ID")
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    region = os.getenv("R2_REGION", "auto")
    if not account_id or not access_key or not secret_key:
        raise RuntimeError(
            "Missing R2 credentials; set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY"
        )
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
    )


def _r2_bucket() -> str:
    bucket = os.getenv("R2_BUCKET_NAME")
    if not bucket:
        raise RuntimeError("Missing R2_BUCKET_NAME")
    return bucket


def _derive_dest_key(source_key: str) -> str:
    if source_key.endswith(".epub"):
        return source_key[: -len(".epub")] + ".transformed.epub"
    return source_key + ".transformed.epub"


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

    return api
