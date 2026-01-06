export interface AuthUser {
  id: string
  email: string
}

export interface MagicLinkResponse {
  verifyUrl?: string
}

const defaultApiUrl = 'http://localhost:8080'

export function apiBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return defaultApiUrl
}

export async function getMe(): Promise<AuthUser | null> {
  const response = await fetch(`${apiBaseUrl()}/auth/me`, {
    credentials: 'include',
  })

  if (response.status === 401) {
    return null
  }

  if (!response.ok) {
    throw new Error('Failed to fetch user')
  }

  return response.json()
}

export async function requestMagicLink(
  email: string,
  redirect?: string,
): Promise<MagicLinkResponse> {
  const response = await fetch(`${apiBaseUrl()}/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, redirect }),
  })

  if (!response.ok) {
    throw new Error('Failed to request magic link')
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return {}
  }

  const json = (await response.json()) as unknown
  if (!json || typeof json !== 'object') return {}
  const verifyUrl = (json as { verifyUrl?: unknown }).verifyUrl
  return typeof verifyUrl === 'string' ? { verifyUrl } : {}
}

export async function logout(): Promise<void> {
  const response = await fetch(`${apiBaseUrl()}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })

  if (!response.ok && response.status !== 204) {
    throw new Error('Failed to log out')
  }
}
