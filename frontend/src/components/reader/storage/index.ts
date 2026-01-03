// Storage Module
// IndexedDB-based persistence for books, positions, settings, and annotations

import type {
  StoredBook,
  StoredPosition,
  StoredSettings,
  Annotation,
  ReaderSettings,
  EpubMetadata,
  DEFAULT_SETTINGS,
} from '../types'

const DB_NAME = 'epub-reader'
const DB_VERSION = 1

const STORES = {
  BOOKS: 'books',
  POSITIONS: 'positions',
  SETTINGS: 'settings',
  ANNOTATIONS: 'annotations',
  SEARCH_INDEX: 'searchIndex',
} as const

export class ReaderStorage {
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null

  async open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    if (this.dbPromise) return this.dbPromise

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        reject(new Error('Failed to open database'))
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Books store
        if (!db.objectStoreNames.contains(STORES.BOOKS)) {
          const booksStore = db.createObjectStore(STORES.BOOKS, { keyPath: 'id' })
          booksStore.createIndex('url', 'url', { unique: false })
          booksStore.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false })
        }

        // Positions store
        if (!db.objectStoreNames.contains(STORES.POSITIONS)) {
          const positionsStore = db.createObjectStore(STORES.POSITIONS, { keyPath: 'bookId' })
          positionsStore.createIndex('updatedAt', 'updatedAt', { unique: false })
        }

        // Settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'id' })
        }

        // Annotations store
        if (!db.objectStoreNames.contains(STORES.ANNOTATIONS)) {
          const annotationsStore = db.createObjectStore(STORES.ANNOTATIONS, { keyPath: 'id' })
          annotationsStore.createIndex('bookId', 'bookId', { unique: false })
          annotationsStore.createIndex('type', 'type', { unique: false })
          annotationsStore.createIndex('createdAt', 'createdAt', { unique: false })
        }

        // Search index store
        if (!db.objectStoreNames.contains(STORES.SEARCH_INDEX)) {
          const searchStore = db.createObjectStore(STORES.SEARCH_INDEX, { keyPath: 'bookId' })
          searchStore.createIndex('builtAt', 'builtAt', { unique: false })
        }
      }
    })

    return this.dbPromise
  }

  // =========================================================================
  // Books
  // =========================================================================

  async saveBook(
    id: string,
    url: string,
    blob: Blob,
    metadata: EpubMetadata
  ): Promise<StoredBook> {
    const db = await this.open()

    // Generate hash
    const hash = await this.hashBlob(blob)

    const book: StoredBook = {
      id,
      url,
      blob,
      metadata,
      hash,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
      offlineEnabled: false,
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.BOOKS, 'readwrite')
      const store = tx.objectStore(STORES.BOOKS)
      const request = store.put(book)

      request.onerror = () => reject(new Error('Failed to save book'))
      request.onsuccess = () => resolve(book)
    })
  }

  async getBook(id: string): Promise<StoredBook | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.BOOKS, 'readonly')
      const store = tx.objectStore(STORES.BOOKS)
      const request = store.get(id)

      request.onerror = () => reject(new Error('Failed to get book'))
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  async getBookByUrl(url: string): Promise<StoredBook | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.BOOKS, 'readonly')
      const store = tx.objectStore(STORES.BOOKS)
      const index = store.index('url')
      const request = index.get(url)

      request.onerror = () => reject(new Error('Failed to get book by URL'))
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  async getAllBooks(): Promise<StoredBook[]> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.BOOKS, 'readonly')
      const store = tx.objectStore(STORES.BOOKS)
      const request = store.getAll()

      request.onerror = () => reject(new Error('Failed to get books'))
      request.onsuccess = () => resolve(request.result || [])
    })
  }

  async updateBookLastOpened(id: string): Promise<void> {
    const db = await this.open()
    const book = await this.getBook(id)
    if (!book) return

    book.lastOpenedAt = Date.now()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.BOOKS, 'readwrite')
      const store = tx.objectStore(STORES.BOOKS)
      const request = store.put(book)

      request.onerror = () => reject(new Error('Failed to update book'))
      request.onsuccess = () => resolve()
    })
  }

  async deleteBook(id: string): Promise<void> {
    const db = await this.open()

    // Delete book, position, and annotations
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORES.BOOKS, STORES.POSITIONS, STORES.ANNOTATIONS, STORES.SEARCH_INDEX],
        'readwrite'
      )

      tx.objectStore(STORES.BOOKS).delete(id)
      tx.objectStore(STORES.POSITIONS).delete(id)
      tx.objectStore(STORES.SEARCH_INDEX).delete(id)

      // Delete annotations by bookId
      const annotationsStore = tx.objectStore(STORES.ANNOTATIONS)
      const index = annotationsStore.index('bookId')
      const request = index.openCursor(IDBKeyRange.only(id))

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error('Failed to delete book'))
    })
  }

  // =========================================================================
  // Reading Positions
  // =========================================================================

  async savePosition(
    bookId: string,
    cfi: string,
    spineHref: string,
    percentage: number
  ): Promise<void> {
    const db = await this.open()

    const position: StoredPosition = {
      bookId,
      cfi,
      spineHref,
      percentage,
      updatedAt: Date.now(),
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.POSITIONS, 'readwrite')
      const store = tx.objectStore(STORES.POSITIONS)
      const request = store.put(position)

      request.onerror = () => reject(new Error('Failed to save position'))
      request.onsuccess = () => resolve()
    })
  }

  async getPosition(bookId: string): Promise<StoredPosition | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.POSITIONS, 'readonly')
      const store = tx.objectStore(STORES.POSITIONS)
      const request = store.get(bookId)

      request.onerror = () => reject(new Error('Failed to get position'))
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  // =========================================================================
  // Settings
  // =========================================================================

  async saveSettings(settings: StoredSettings): Promise<void> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readwrite')
      const store = tx.objectStore(STORES.SETTINGS)
      const request = store.put({ id: 'global', ...settings })

      request.onerror = () => reject(new Error('Failed to save settings'))
      request.onsuccess = () => resolve()
    })
  }

  async getSettings(): Promise<StoredSettings | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readonly')
      const store = tx.objectStore(STORES.SETTINGS)
      const request = store.get('global')

      request.onerror = () => reject(new Error('Failed to get settings'))
      request.onsuccess = () => {
        const result = request.result
        if (result) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { id, ...settings } = result
          resolve(settings as StoredSettings)
        } else {
          resolve(null)
        }
      }
    })
  }

  async saveBookSettings(bookId: string, settings: Partial<ReaderSettings>): Promise<void> {
    const current = await this.getSettings()
    const updated: StoredSettings = current || {
      global: {
        theme: 'light',
        fontFamily: 'publisher',
        fontSize: 1.0,
        lineHeight: 1.6,
        marginSize: 'medium',
        textAlign: 'left',
        paragraphSpacing: 1.0,
        mode: 'paginated',
      },
      perBook: {},
    }

    updated.perBook[bookId] = { ...updated.perBook[bookId], ...settings }
    await this.saveSettings(updated)
  }

  // =========================================================================
  // Annotations
  // =========================================================================

  async saveAnnotation(annotation: Annotation): Promise<void> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readwrite')
      const store = tx.objectStore(STORES.ANNOTATIONS)
      const request = store.put(annotation)

      request.onerror = () => reject(new Error('Failed to save annotation'))
      request.onsuccess = () => resolve()
    })
  }

  async saveAnnotations(annotations: Annotation[]): Promise<void> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readwrite')
      const store = tx.objectStore(STORES.ANNOTATIONS)

      for (const annotation of annotations) {
        store.put(annotation)
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error('Failed to save annotations'))
    })
  }

  async getAnnotation(id: string): Promise<Annotation | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readonly')
      const store = tx.objectStore(STORES.ANNOTATIONS)
      const request = store.get(id)

      request.onerror = () => reject(new Error('Failed to get annotation'))
      request.onsuccess = () => resolve(request.result || null)
    })
  }

  async getAnnotationsForBook(bookId: string): Promise<Annotation[]> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readonly')
      const store = tx.objectStore(STORES.ANNOTATIONS)
      const index = store.index('bookId')
      const request = index.getAll(IDBKeyRange.only(bookId))

      request.onerror = () => reject(new Error('Failed to get annotations'))
      request.onsuccess = () => resolve(request.result || [])
    })
  }

  async deleteAnnotation(id: string): Promise<void> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readwrite')
      const store = tx.objectStore(STORES.ANNOTATIONS)
      const request = store.delete(id)

      request.onerror = () => reject(new Error('Failed to delete annotation'))
      request.onsuccess = () => resolve()
    })
  }

  // =========================================================================
  // Storage Management
  // =========================================================================

  async getStorageUsage(): Promise<{ used: number; quota: number }> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate()
      return {
        used: estimate.usage || 0,
        quota: estimate.quota || 0,
      }
    }
    return { used: 0, quota: 0 }
  }

  async clearAllData(): Promise<void> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const storeNames = Array.from(db.objectStoreNames)
      const tx = db.transaction(storeNames, 'readwrite')

      for (const storeName of storeNames) {
        tx.objectStore(storeName).clear()
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error('Failed to clear data'))
    })
  }

  async exportData(): Promise<string> {
    const books = await this.getAllBooks()
    const settings = await this.getSettings()

    // Get all annotations
    const db = await this.open()
    const annotations = await new Promise<Annotation[]>((resolve, reject) => {
      const tx = db.transaction(STORES.ANNOTATIONS, 'readonly')
      const store = tx.objectStore(STORES.ANNOTATIONS)
      const request = store.getAll()

      request.onerror = () => reject(new Error('Failed to export annotations'))
      request.onsuccess = () => resolve(request.result || [])
    })

    // Get all positions
    const positions = await new Promise<StoredPosition[]>((resolve, reject) => {
      const tx = db.transaction(STORES.POSITIONS, 'readonly')
      const store = tx.objectStore(STORES.POSITIONS)
      const request = store.getAll()

      request.onerror = () => reject(new Error('Failed to export positions'))
      request.onsuccess = () => resolve(request.result || [])
    })

    const exportData = {
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      annotations,
      positions,
      books: books.map((b) => ({
        id: b.id,
        url: b.url,
        metadata: b.metadata,
        addedAt: b.addedAt,
        lastOpenedAt: b.lastOpenedAt,
        offlineEnabled: b.offlineEnabled,
      })),
    }

    return JSON.stringify(exportData, null, 2)
  }

  private async hashBlob(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.dbPromise = null
    }
  }
}

// Singleton instance
export const readerStorage = new ReaderStorage()
