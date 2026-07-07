import { createServerFn } from '@tanstack/react-start'

export interface Book {
  id: string
  url: string
  title: string
  authors: string[]
  thumbnail_url: string
  transformation_data: Record<string, string[]>
  format: 'epub' | 'pdf'
  pdf_has_text_layer: boolean | null
  page_count: number | null
  visibility?: string
  owner_user_id?: string | null
}

export interface CursorPage<T> {
  items: T[]
  total: number
  limit: number
  next_cursor?: string | null
}

export interface TransformStatus {
  status: 'not_started' | 'pending' | 'running' | 'ready' | 'error'
  dest_key: string
  url?: string
  call_id?: string
  error?: string
  created_at?: string
  updated_at?: string
}

export type TransformType = 'modernify' | 'translate'

const defaultApiUrl = 'http://localhost:8080'

function apiBase() {
  return import.meta.env.VITE_API_URL || defaultApiUrl
}

async function transformErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = await response.clone().json()
    const message = String(payload?.error ?? payload?.message ?? '').trim()
    if (message) return message
  } catch {
    // fall through to text response
  }
  const text = (await response.text().catch(() => '')).trim()
  return text || fallback
}

export function getBookFileUrl(
  bookId: string,
  options?: { variant?: string },
): string {
  const base = apiBase()
  const variant = String(options?.variant ?? '').trim()
  const suffix = variant ? `?variant=${encodeURIComponent(variant)}` : ''
  return `${base}/books/${encodeURIComponent(bookId)}/file${suffix}`
}

export function getBookThumbnailUrl(bookId: string): string {
  const base = apiBase()
  return `${base}/books/${encodeURIComponent(bookId)}/thumbnail`
}

export const getBooks = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Book[]> => {
  const response = await fetch(`${apiBase()}/books`, {
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error('Failed to fetch books')
  }

  return response.json()
})

export async function searchBooks(options?: {
  query?: string
  limit?: number
  cursor?: string | null
  scope?: 'public' | 'personal'
}): Promise<CursorPage<Book>> {
  const params = new URLSearchParams()
  const query = options?.query ?? ''
  const limit = options?.limit ?? 50
  const cursor = options?.cursor ?? null
  const scope = options?.scope ?? 'public'
  params.set('q', query)
  params.set('limit', String(limit))
  params.set('scope', scope)
  if (cursor) params.set('cursor', cursor)

  const response = await fetch(`${apiBase()}/books/search?${params}`, {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error('Failed to fetch books')
  }
  return response.json()
}

export async function getBook(bookId: string): Promise<Book | null> {
  const response = await fetch(`${apiBase()}/books/${bookId}`, {
    credentials: 'include',
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error('Failed to fetch book')
  }
  return response.json()
}

export async function uploadBook(options: {
  file: File
  title?: string
}): Promise<Book> {
  const form = new FormData()
  form.set('file', options.file)
  if (options.title) form.set('title', options.title)

  const response = await fetch(`${apiBase()}/books/upload`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to upload book')
  }
  return response.json()
}

export async function deleteBook(bookId: string): Promise<void> {
  const response = await fetch(
    `${apiBase()}/books/${encodeURIComponent(bookId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
    },
  )

  if (response.status === 204 || response.status === 404) return

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to delete book')
  }
}

export const startBookTransform = async (
  bookId: string,
  arg?:
    | string
    | {
        type?: TransformType
        lang?: string
        prompt?: string
        force?: boolean
      },
): Promise<TransformStatus> => {
  const options = typeof arg === 'string' ? { prompt: arg } : (arg ?? {})
  const { type, lang, prompt, force } = options
  const response = await fetch(`${apiBase()}/books/${bookId}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      ...(type ? { type } : {}),
      ...(lang ? { lang } : {}),
      ...(prompt ? { prompt } : {}),
      ...(force ? { force: true } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(
      await transformErrorMessage(response, 'Failed to start transform'),
    )
  }

  return response.json()
}

export const getBookTransform = async (
  bookId: string,
  options?: { type?: TransformType; lang?: string },
): Promise<TransformStatus> => {
  const params = new URLSearchParams()
  if (options?.type) params.set('type', options.type)
  if (options?.lang) params.set('lang', options.lang)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(
    `${apiBase()}/books/${bookId}/transform${suffix}`,
    {
      credentials: 'include',
    },
  )

  if (!response.ok) {
    throw new Error(
      await transformErrorMessage(response, 'Failed to fetch transform status'),
    )
  }

  return response.json()
}
