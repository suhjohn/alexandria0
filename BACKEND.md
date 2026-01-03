## Data model

books

- id: uuid
- url: str
- title: str
- authors: List[str]
- thumbnail_url: str
- transformation_data: Dict[str, List[str]] - k, v where key is transformation variant ("simplify", "simplify") and v is list of urls of the transformed book

## env

DATABASE_URL: Postgres url in .env

- We should have a local postgres from docker-compose. Make sure to have the PORT be something rather unique since we have a couple postgres running

## Commands

sync_gutenberg (n: int)

- Fetch n books from Gutenberg (not just Top100 but all book)
- For each book, download metadata + EPUB file
- Find the thumbnail image from the EPUB file
- Create a book row per the Gutenberg obj

### Production backfill

Run the Gutenberg sync against production config by loading `.env.production`:

```bash
APP_ENV=production server sync-gutenberg --count 50
```

Or explicitly:

```bash
server --env production sync-gutenberg --count 50
```

## APIs

GET /health
Healtcheck API

GET /books

Retrieve all the books rows
