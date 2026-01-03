// EPUB Fetcher Module
// Handles downloading EPUBs with progress, range requests, retries

export interface FetchProgress {
  loaded: number
  total: number
  percentage: number
}

export interface FetchOptions {
  headers?: Record<string, string>
  onProgress?: (progress: FetchProgress) => void
  signal?: AbortSignal
  useRangeRequests?: boolean
  retries?: number
  retryDelay?: number
}

export interface FetchResult {
  blob: Blob
  etag?: string
  lastModified?: string
  contentType: string
}

const DEFAULT_RETRY_COUNT = 3
const DEFAULT_RETRY_DELAY = 1000

export class EpubFetcher {
  private cache = new Map<string, FetchResult>()

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const {
      headers = {},
      onProgress,
      signal,
      retries = DEFAULT_RETRY_COUNT,
      retryDelay = DEFAULT_RETRY_DELAY,
    } = options

    // Check cache first
    const cached = this.cache.get(url)
    if (cached) {
      onProgress?.({ loaded: cached.blob.size, total: cached.blob.size, percentage: 100 })
      return cached
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.fetchWithProgress(url, headers, onProgress, signal)
        this.cache.set(url, result)
        return result
      } catch (error) {
        lastError = error as Error

        if (signal?.aborted) {
          throw new Error('Fetch aborted')
        }

        if (attempt < retries) {
          await this.delay(retryDelay * Math.pow(2, attempt))
        }
      }
    }

    throw lastError || new Error('Failed to fetch EPUB')
  }

  private async fetchWithProgress(
    url: string,
    headers: Record<string, string>,
    onProgress?: (progress: FetchProgress) => void,
    signal?: AbortSignal
  ): Promise<FetchResult> {
    const response = await fetch(url, {
      headers,
      signal,
      credentials: 'same-origin',
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const etag = response.headers.get('ETag') || undefined
    const lastModified = response.headers.get('Last-Modified') || undefined
    const contentType = response.headers.get('Content-Type') || 'application/epub+zip'
    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10)

    if (!response.body) {
      // Fallback for browsers without streaming support
      const blob = await response.blob()
      onProgress?.({ loaded: blob.size, total: blob.size, percentage: 100 })
      return { blob, etag, lastModified, contentType }
    }

    // Stream the response with progress
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0

    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      chunks.push(value)
      loaded += value.length

      if (onProgress) {
        const total = contentLength || loaded
        const percentage = contentLength ? Math.round((loaded / total) * 100) : 0
        onProgress({ loaded, total, percentage })
      }
    }

    const blob = new Blob(chunks, { type: contentType })
    return { blob, etag, lastModified, contentType }
  }

  async fetchWithRangeRequest(
    url: string,
    start: number,
    end: number,
    headers: Record<string, string> = {}
  ): Promise<ArrayBuffer> {
    const response = await fetch(url, {
      headers: {
        ...headers,
        Range: `bytes=${start}-${end}`,
      },
    })

    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`Range request failed: ${response.status}`)
    }

    return response.arrayBuffer()
  }

  async supportsRangeRequests(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
      })

      return response.headers.get('Accept-Ranges') === 'bytes'
    } catch {
      return false
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  removeFromCache(url: string): void {
    this.cache.delete(url)
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// Singleton instance
export const epubFetcher = new EpubFetcher()
