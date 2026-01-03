export interface AuthUser {
  id: string
  email: string
}

const defaultApiUrl = 'http://localhost:8080'

function apiBase() {
  return import.meta.env.VITE_API_URL || defaultApiUrl
}

export async function getMe(): Promise<AuthUser | null> {
  const response = await fetch(`${apiBase()}/auth/me`, {
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

export async function requestMagicLink(email: string): Promise<void> {
  const response = await fetch(`${apiBase()}/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  })

  if (!response.ok) {
    throw new Error('Failed to request magic link')
  }
}

export async function logout(): Promise<void> {
  const response = await fetch(`${apiBase()}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })

  if (!response.ok && response.status !== 204) {
    throw new Error('Failed to log out')
  }
}
