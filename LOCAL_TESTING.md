# Local PDF/EPUB Testing

This setup runs the real app flow locally:

`frontend -> Go API -> Postgres -> MinIO/S3 -> Python classify/transform worker`

It is intended to catch browser issues around uploaded PDFs, presigned URLs,
Range requests, text-layer classification, and EPUB/PDF reader behavior.

## 1. Start local infrastructure

```bash
cd server
docker compose up -d postgres minio minio-init
```

MinIO console: http://localhost:9001

Credentials:

```text
modernfiction / modernfiction-password
```

The MinIO container allows CORS for `localhost:3000` and `localhost:4173`.
The initializer creates the `modernfiction` bucket.

## 2. Run the Python worker

```bash
cd epubtransform
cp .env.local.example .env.local
set -a
. ./.env.local
set +a
uv run uvicorn modernfiction_v2.local_api:app --host 127.0.0.1 --port 8000
```

`/classify` works without an LLM key. `/transform` uses the existing transform
pipeline; if provider calls fail locally, the pipeline keeps original text while
still exercising the PDF-to-EPUB and upload plumbing.

## 3. Run the Go API

```bash
cd server
cp .env.local.example .env.local
go run ./cmd/server --env-file .env.local migrate
go run ./cmd/server --env-file .env.local serve --port 8080
```

Local auth returns a verify URL when `RESEND_API_KEY` and `RESEND_FROM` are
blank.

## 4. Run the frontend

```bash
cd frontend
PATH="/Users/johnsuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  ./node_modules/.bin/vite preview --host localhost --port 4173
```

Open http://localhost:4173.

## 5. Verification checklist

Sign in through the local magic-link flow:

```bash
curl -sS -X POST http://localhost:8080/auth/request \
  -H 'Content-Type: application/json' \
  --data '{"email":"local@example.com","redirect":"/"}'
```

Open the returned `verifyUrl` in the browser.

Then verify:

- Personal library upload accepts `.epub` and `.pdf`.
- Uploaded EPUB opens in the EPUB reader.
- Uploaded PDF appears with `PDF`, then classification fills `page_count` and
  clears `Processing...`.
- Uploaded PDF opens in the PDF reader from `/books/{id}/file`.
- The presigned MinIO response supports browser `Range` requests and CORS.
- PDF settings show Spread/Fit/Zoom controls.
- For text-layer PDFs, chat page mentions resolve to text parts.
- For image-only PDFs, chat page mentions resolve to page images.
