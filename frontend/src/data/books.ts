import { createServerFn } from '@tanstack/react-start'

export interface Book {
  id: string
  url: string
  title: string
  authors: string[]
  thumbnail_url: string
  transformation_data: Record<string, string[]>
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

export const startBookTransform = async (
  bookId: string,
  arg?: string | { type?: TransformType; lang?: string; prompt?: string },
): Promise<TransformStatus> => {
  const options = typeof arg === 'string' ? { prompt: arg } : (arg ?? {})
  const { type, lang, prompt } = options
  const response = await fetch(`${apiBase()}/books/${bookId}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      ...(type ? { type } : {}),
      ...(lang ? { lang } : {}),
      ...(prompt ? { prompt } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error('Failed to start transform')
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
    throw new Error('Failed to fetch transform status')
  }

  return response.json()
}
