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

export interface TransformStatus {
  status: 'pending' | 'running' | 'ready' | 'error'
  dest_key: string
  url?: string
  call_id?: string
  error?: string
}

const defaultApiUrl = 'http://localhost:8080'

export const getBooks = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Book[]> => {
  const apiUrl = import.meta.env.VITE_API_URL || defaultApiUrl
  const response = await fetch(`${apiUrl}/books`, {
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error('Failed to fetch books')
  }

  return response.json()
})

export const startBookTransform = async (
  bookId: string,
  prompt?: string,
): Promise<TransformStatus> => {
  const apiUrl = import.meta.env.VITE_API_URL || defaultApiUrl
  const response = await fetch(`${apiUrl}/books/${bookId}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(prompt ? { prompt } : {}),
  })

  if (!response.ok) {
    throw new Error('Failed to start transform')
  }

  return response.json()
}

export const getBookTransform = async (
  bookId: string,
): Promise<TransformStatus> => {
  const apiUrl = import.meta.env.VITE_API_URL || defaultApiUrl
  const response = await fetch(`${apiUrl}/books/${bookId}/transform`, {
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error('Failed to fetch transform status')
  }

  return response.json()
}
