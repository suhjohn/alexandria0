import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

export interface CursorPage<T> {
  items: T[]
  total: number
  limit: number
  next_cursor?: string | null
}

export function useInfiniteCursorQuery<T>(options: {
  queryKey: unknown[]
  limit: number
  enabled?: boolean
  queryFn: (args: {
    cursor: string | null
    limit: number
  }) => Promise<CursorPage<T>>
}) {
  const query = useInfiniteQuery({
    queryKey: [...options.queryKey, options.limit],
    enabled: options.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      options.queryFn({ cursor: pageParam, limit: options.limit }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    placeholderData: (prev) => prev,
  })

  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  )
  const total = query.data?.pages[0]?.total ?? 0
  const limit = options.limit

  return {
    ...query,
    items,
    total,
    limit,
  }
}
