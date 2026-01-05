import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

export interface CursorPage<T> {
  items: T[]
  total: number
  limit: number
  next_cursor?: string | null
}

export function useCursorPager<T>(options: {
  queryKey: unknown[]
  limit: number
  queryFn: (args: {
    cursor: string | null
    limit: number
  }) => Promise<CursorPage<T>>
}) {
  const { limit, queryFn } = options
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])
  const cursor = cursorStack[cursorStack.length - 1] ?? null
  const pageNumber = cursorStack.length

  const query = useQuery({
    queryKey: [...options.queryKey, cursor, limit],
    queryFn: () => queryFn({ cursor, limit }),
    placeholderData: (prev) => prev,
  })

  const nextCursor = query.data?.next_cursor ?? null
  const total = query.data?.total ?? 0
  const items = query.data?.items ?? []

  const canPrev = cursorStack.length > 1
  const canNext = Boolean(nextCursor)

  const reset = () => setCursorStack([null])
  const prev = () => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  const next = () => {
    if (!nextCursor) return
    setCursorStack((s) => [...s, nextCursor])
  }

  return {
    ...query,
    items,
    total,
    nextCursor,
    pageNumber,
    canPrev,
    canNext,
    reset,
    prev,
    next,
  }
}
