# Alexandria

A digital library platform with AI-powered reading and book transformation.

## Why Alexandria?

- **Read classics in modern English** — Transform archaic prose ("thee", "hath") into contemporary language while preserving the story
- **Chat with AI about what you're reading** — Select any passage and discuss it with Gemini, with full context awareness
- **Access 70,000+ free books** — Browse Project Gutenberg's catalog or upload your own EPUBs
- **Translate books** — Convert entire books to 50+ languages with LLM-powered translation

## Features

| Feature | Description |
|---------|-------------|
| **EPUB Reader** | Customizable themes, fonts, and layouts with epubjs |
| **AI Chat** | Gemini-powered sidebar for discussing passages (history stored locally) |
| **Modernify** | Rewrite archaic language into modern prose |
| **Translation** | Full-book translation to any language |
| **Personal Library** | Upload EPUBs, private by default, shareable via link |
| **Public Library** | Project Gutenberg integration with full-text search |

## Quick Start

```bash
# Frontend
cd frontend && pnpm install && pnpm dev

# Backend
cd backend && go run main.go

# Transformations (optional)
cd epubtransform && uv sync
```

**Requirements:** Node.js 18+, Go 1.24+, PostgreSQL, Cloudflare R2 (or S3)

## Architecture

```
React 19 + TanStack  →  Go/Chi API  →  PostgreSQL + R2
                                    →  Python/Modal (transformations)
```

- **Frontend:** React 19, TypeScript, TanStack Router/Query, Tailwind, epubjs
- **Backend:** Go 1.24, Chi, PostgreSQL, OAuth 2.0
- **Transformations:** Python 3.12, FastAPI, LiteLLM, Modal.com

## Project Structure

```
frontend/        # React SPA
backend/         # Go API server
epubtransform/   # Python transformation workers
```

See `.env.example` files in each directory for configuration.
