import * as React from 'react'

export function useCookie(
  name: string,
  defaultValue: string,
  serverValue?: string,
) {
  const [value, setValue] = React.useState<string>(() => {
    if (serverValue !== undefined) return serverValue
    if (typeof document === 'undefined') return defaultValue
    const cookie = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((row) => row.startsWith(`${name}=`))
    return cookie
      ? decodeURIComponent(cookie.slice(name.length + 1))
      : defaultValue
  })

  const updateCookie = React.useCallback(
    (newValue: string, options: { path?: string; maxAge?: number } = {}) => {
      if (typeof document === 'undefined') return
      const { path = '/', maxAge = 31536000 } = options
      document.cookie = `${name}=${encodeURIComponent(newValue)}; path=${path}; max-age=${maxAge}; SameSite=Lax`
      setValue(newValue)
    },
    [name],
  )

  return [value, updateCookie] as const
}
