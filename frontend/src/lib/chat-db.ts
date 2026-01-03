import type { SqlJsStatic } from 'sql.js'

export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatConversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type ChatMessage = {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  contentJson?: string | null
  createdAt: number
  parentId?: string | null
  editedAt?: number | null
}

const IDB_DB_NAME = 'mfv2-chat'
const IDB_STORE_NAME = 'kv'
const IDB_SQLITE_KEY = 'sqlite-db-v1'

const KV_API_KEY = 'gemini_api_key'
const KV_SELECTED_CONVERSATION_ID = 'selected_conversation_id'

let idbPromise: Promise<IDBDatabase> | null = null

async function openIdb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment.')
  }

  if (idbPromise) return idbPromise

  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return idbPromise
}

async function idbGetArrayBuffer(key: string): Promise<ArrayBuffer | null> {
  const db = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly')
    const store = tx.objectStore(IDB_STORE_NAME)
    const request = store.get(key)
    request.onsuccess = () => {
      const value = request.result
      resolve(value instanceof ArrayBuffer ? value : null)
    }
    request.onerror = () => reject(request.error)
  })
}

async function idbSetArrayBuffer(
  key: string,
  value: ArrayBuffer,
): Promise<void> {
  const db = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite')
    const store = tx.objectStore(IDB_STORE_NAME)
    const request = store.put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function getSqlJsWasmUrl() {
  const baseUrl = import.meta.env.BASE_URL || '/'
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBaseUrl}sql.js/dist/sql-wasm.wasm`
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise) return sqlJsPromise

  sqlJsPromise = (async () => {
    const { default: initSqlJs } = await import('sql.js')
    return initSqlJs({
      locateFile: () => getSqlJsWasmUrl(),
    })
  })()

  return sqlJsPromise
}

function ensureBrowserOnly() {
  if (typeof window === 'undefined') {
    throw new Error('Chat DB can only be used in the browser.')
  }
}

function nowMs() {
  return Date.now()
}

function normalizeString(value: string) {
  return value.trim()
}

function ensureSchema(db: { exec: (sql: string) => unknown }) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      content_json TEXT,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at
      ON messages(conversation_id, created_at);
  `)
}

function tableHasColumn(
  db: any,
  tableName: string,
  columnName: string,
): boolean {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
      if (String(row.name) === columnName) return true
    }
    return false
  } finally {
    stmt.free()
  }
}

function dbHasIndex(db: any, indexName: string): boolean {
  const stmt = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`,
  )
  try {
    stmt.bind([indexName])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function migrateSchema(db: any): boolean {
  let changed = false
  // Add columns to existing databases created before parent/thread support.
  if (!tableHasColumn(db, 'messages', 'parent_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT`)
    changed = true
  }
  if (!tableHasColumn(db, 'messages', 'edited_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`)
    changed = true
  }
  if (!tableHasColumn(db, 'messages', 'content_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN content_json TEXT`)
    changed = true
  }

  const parentIndexName = 'idx_messages_conversation_id_parent_id'
  if (!dbHasIndex(db, parentIndexName)) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${parentIndexName}
       ON messages(conversation_id, parent_id);`,
    )
    changed = true
  }

  // Backfill parent chain for legacy conversations (single linear history).
  const convoStmt = db.prepare(`SELECT id FROM conversations`)
  try {
    while (convoStmt.step()) {
      const convoRow = convoStmt.getAsObject() as Record<string, unknown>
      const conversationId = String(convoRow.id)

      const msgStmt = db.prepare(
        `SELECT id, parent_id
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      try {
        msgStmt.bind([conversationId])
        const rows: Array<{ id: string; parentId: string | null }> = []
        while (msgStmt.step()) {
          const row = msgStmt.getAsObject() as Record<string, unknown>
          rows.push({
            id: String(row.id),
            parentId: row.parent_id ? String(row.parent_id) : null,
          })
        }

        if (rows.length <= 1) continue
        const alreadyHasParents = rows.some((r) => r.parentId !== null)
        if (alreadyHasParents) continue

        db.exec('BEGIN')
        try {
          const updateStmt = db.prepare(
            `UPDATE messages SET parent_id = ? WHERE id = ?`,
          )
          try {
            for (let i = 1; i < rows.length; i++) {
              updateStmt.run([rows[i - 1].id, rows[i].id])
            }
          } finally {
            updateStmt.free()
          }
          db.exec('COMMIT')
          changed = true
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      } finally {
        msgStmt.free()
      }
    }
  } finally {
    convoStmt.free()
  }

  return changed
}

function rowToConversation(row: Record<string, unknown>): ChatConversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    role: String(row.role) as ChatRole,
    content: String(row.content),
    contentJson:
      typeof row.content_json === 'string' ? String(row.content_json) : null,
    createdAt: Number(row.created_at),
    editedAt: typeof row.edited_at === 'number' ? Number(row.edited_at) : null,
  }
}

class ChatDb {
  private db: any
  private persistTimer: number | null = null
  private persistInFlight: Promise<void> | null = null

  constructor(db: any) {
    this.db = db
    ensureSchema(this.db)
    if (migrateSchema(this.db)) {
      this.schedulePersist()
    }
  }

  private schedulePersist() {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 250)
  }

  async persist() {
    if (this.persistInFlight) return this.persistInFlight

    this.persistInFlight = (async () => {
      const exported = this.db.export() as Uint8Array
      const copy = new Uint8Array(exported)
      await idbSetArrayBuffer(IDB_SQLITE_KEY, copy.buffer)
    })()

    try {
      await this.persistInFlight
    } finally {
      this.persistInFlight = null
    }
  }

  getApiKey(): string | null {
    const stmt = this.db.prepare(
      `SELECT value FROM app_kv WHERE key = ? LIMIT 1`,
    )
    try {
      stmt.bind([KV_API_KEY])
      if (!stmt.step()) return null
      const row = stmt.getAsObject() as Record<string, unknown>
      const value = typeof row.value === 'string' ? row.value : null
      return value ? normalizeString(value) : null
    } finally {
      stmt.free()
    }
  }

  setApiKey(apiKey: string | null) {
    const next = apiKey ? normalizeString(apiKey) : ''
    this.db.exec('BEGIN')
    try {
      const deleteStmt = this.db.prepare(`DELETE FROM app_kv WHERE key = ?`)
      try {
        deleteStmt.run([KV_API_KEY])
      } finally {
        deleteStmt.free()
      }
      if (next) {
        const stmt = this.db.prepare(
          `INSERT INTO app_kv(key, value) VALUES (?, ?)`,
        )
        try {
          stmt.run([KV_API_KEY, next])
        } finally {
          stmt.free()
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.schedulePersist()
  }

  getSelectedConversationId(): string | null {
    const stmt = this.db.prepare(
      `SELECT value FROM app_kv WHERE key = ? LIMIT 1`,
    )
    try {
      stmt.bind([KV_SELECTED_CONVERSATION_ID])
      if (!stmt.step()) return null
      const row = stmt.getAsObject() as Record<string, unknown>
      return typeof row.value === 'string' ? row.value : null
    } finally {
      stmt.free()
    }
  }

  setSelectedConversationId(conversationId: string | null) {
    const next = conversationId ? normalizeString(conversationId) : ''
    this.db.exec('BEGIN')
    try {
      const deleteStmt = this.db.prepare(`DELETE FROM app_kv WHERE key = ?`)
      try {
        deleteStmt.run([KV_SELECTED_CONVERSATION_ID])
      } finally {
        deleteStmt.free()
      }
      if (next) {
        const stmt = this.db.prepare(
          `INSERT INTO app_kv(key, value) VALUES (?, ?)`,
        )
        try {
          stmt.run([KV_SELECTED_CONVERSATION_ID, next])
        } finally {
          stmt.free()
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.schedulePersist()
  }

  getActiveMessageId(conversationId: string): string | null {
    const stmt = this.db.prepare(
      `SELECT value FROM app_kv WHERE key = ? LIMIT 1`,
    )
    try {
      stmt.bind([`active_message_id:${conversationId}`])
      if (!stmt.step()) return null
      const row = stmt.getAsObject() as Record<string, unknown>
      return typeof row.value === 'string' ? row.value : null
    } finally {
      stmt.free()
    }
  }

  setActiveMessageId(conversationId: string, messageId: string | null) {
    const key = `active_message_id:${conversationId}`
    const next = messageId ? normalizeString(messageId) : ''

    this.db.exec('BEGIN')
    try {
      const deleteStmt = this.db.prepare(`DELETE FROM app_kv WHERE key = ?`)
      try {
        deleteStmt.run([key])
      } finally {
        deleteStmt.free()
      }
      if (next) {
        const stmt = this.db.prepare(
          `INSERT INTO app_kv(key, value) VALUES (?, ?)`,
        )
        try {
          stmt.run([key, next])
        } finally {
          stmt.free()
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.schedulePersist()
  }

  listConversations(): Array<ChatConversation> {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`,
    )
    try {
      const result: Array<ChatConversation> = []
      while (stmt.step()) {
        result.push(rowToConversation(stmt.getAsObject()))
      }
      return result
    } finally {
      stmt.free()
    }
  }

  createConversation(params: { id: string; title: string }): ChatConversation {
    const createdAt = nowMs()
    const title = normalizeString(params.title) || 'New chat'
    const stmt = this.db.prepare(
      `INSERT INTO conversations(id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    try {
      stmt.run([params.id, title, createdAt, createdAt])
    } finally {
      stmt.free()
    }

    this.schedulePersist()
    return { id: params.id, title, createdAt, updatedAt: createdAt }
  }

  renameConversation(conversationId: string, title: string) {
    const nextTitle = normalizeString(title) || 'New chat'
    const stmt = this.db.prepare(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
    )
    try {
      stmt.run([nextTitle, nowMs(), conversationId])
    } finally {
      stmt.free()
    }
    this.schedulePersist()
  }

  deleteConversation(conversationId: string) {
    const stmt = this.db.prepare(`DELETE FROM conversations WHERE id = ?`)
    try {
      stmt.run([conversationId])
    } finally {
      stmt.free()
    }
    this.schedulePersist()
  }

  countMessages(conversationId: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(1) AS count FROM messages WHERE conversation_id = ?`,
    )
    try {
      stmt.bind([conversationId])
      if (!stmt.step()) return 0
      const row = stmt.getAsObject() as Record<string, unknown>
      return typeof row.count === 'number' ? Number(row.count) : 0
    } finally {
      stmt.free()
    }
  }

  listThreadHeads(conversationId: string): Array<ChatMessage> {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at
       FROM messages
       WHERE conversation_id = ?
         AND id NOT IN (
           SELECT parent_id
           FROM messages
           WHERE conversation_id = ?
             AND parent_id IS NOT NULL
         )
       ORDER BY created_at DESC`,
    )
    try {
      stmt.bind([conversationId, conversationId])
      const result: Array<ChatMessage> = []
      while (stmt.step()) {
        result.push(rowToMessage(stmt.getAsObject()))
      }
      return result
    } finally {
      stmt.free()
    }
  }

  listChildren(
    conversationId: string,
    parentId: string | null,
  ): Array<ChatMessage> {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at
       FROM messages
       WHERE conversation_id = ?
         AND (
           (parent_id IS NULL AND ? IS NULL)
           OR parent_id = ?
         )
       ORDER BY created_at ASC`,
    )
    try {
      stmt.bind([conversationId, parentId, parentId])
      const result: Array<ChatMessage> = []
      while (stmt.step()) {
        result.push(rowToMessage(stmt.getAsObject()))
      }
      return result
    } finally {
      stmt.free()
    }
  }

  listChildrenForParents(
    conversationId: string,
    parentIds: Array<string | null>,
  ): Partial<Record<string, Array<ChatMessage>>> {
    const result: Partial<Record<string, Array<ChatMessage>>> = {}
    const uniqueNonNull = Array.from(
      new Set(parentIds.filter((id): id is string => Boolean(id))),
    )
    const includesNull = parentIds.some((id) => id === null)

    if (includesNull) {
      const stmt = this.db.prepare(
        `SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at
         FROM messages
         WHERE conversation_id = ?
           AND parent_id IS NULL
         ORDER BY created_at ASC`,
      )
      try {
        stmt.bind([conversationId])
        const rows: Array<ChatMessage> = []
        while (stmt.step()) rows.push(rowToMessage(stmt.getAsObject()))
        result.__root__ = rows
      } finally {
        stmt.free()
      }
    }

    if (uniqueNonNull.length === 0) return result

    const placeholders = uniqueNonNull.map(() => '?').join(', ')
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at
       FROM messages
       WHERE conversation_id = ?
         AND parent_id IN (${placeholders})
       ORDER BY parent_id ASC, created_at ASC`,
    )
    try {
      stmt.bind([conversationId, ...uniqueNonNull])
      while (stmt.step()) {
        const message = rowToMessage(stmt.getAsObject())
        const key = message.parentId ?? '__root__'
        if (!result[key]) result[key] = []
        result[key].push(message)
      }
    } finally {
      stmt.free()
    }

    return result
  }

  getLatestLeafDescendant(
    conversationId: string,
    startMessageId: string,
  ): string | null {
    const stmt = this.db.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id
         FROM messages
         WHERE id = ? AND conversation_id = ?
         UNION ALL
         SELECT m.id
         FROM messages m
         JOIN descendants d ON m.parent_id = d.id
         WHERE m.conversation_id = ?
       )
       SELECT m.id
       FROM messages m
       WHERE m.conversation_id = ?
         AND m.id IN descendants
         AND NOT EXISTS (
           SELECT 1
           FROM messages c
           WHERE c.conversation_id = ?
             AND c.parent_id = m.id
         )
       ORDER BY m.created_at DESC
       LIMIT 1`,
    )
    try {
      stmt.bind([
        startMessageId,
        conversationId,
        conversationId,
        conversationId,
        conversationId,
      ])
      if (!stmt.step()) return null
      const row = stmt.getAsObject() as Record<string, unknown>
      return typeof row.id === 'string' ? row.id : String(row.id)
    } finally {
      stmt.free()
    }
  }

  listMessages(
    conversationId: string,
    headMessageId?: string | null,
  ): Array<ChatMessage> {
    let desiredHead: string | null = this.getActiveMessageId(conversationId)
    if (headMessageId !== undefined) desiredHead = headMessageId
    if (!desiredHead) {
      desiredHead = this.listThreadHeads(conversationId)[0]?.id ?? null
    }

    if (!desiredHead) return []

    const stmt = this.db.prepare(
      `WITH RECURSIVE thread(
        id,
        conversation_id,
        parent_id,
        role,
        content,
        content_json,
        created_at,
        edited_at,
        depth
      ) AS (
        SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at, 0
        FROM messages
        WHERE id = ?
        UNION ALL
        SELECT m.id, m.conversation_id, m.parent_id, m.role, m.content, m.content_json, m.created_at, m.edited_at, t.depth + 1
        FROM messages m
        JOIN thread t ON m.id = t.parent_id
      )
      SELECT id, conversation_id, parent_id, role, content, content_json, created_at, edited_at
      FROM thread
      ORDER BY depth DESC`,
    )
    try {
      stmt.bind([desiredHead])
      const result: Array<ChatMessage> = []
      while (stmt.step()) {
        result.push(rowToMessage(stmt.getAsObject()))
      }
      return result
    } finally {
      stmt.free()
    }
  }

  updateMessageContent(
    messageId: string,
    content: string,
    contentJson?: string | null,
  ) {
    const next = normalizeString(content)
    const stmt = this.db.prepare(
      `UPDATE messages SET content = ?, content_json = ?, edited_at = ? WHERE id = ?`,
    )
    try {
      stmt.run([next, contentJson ?? null, nowMs(), messageId])
    } finally {
      stmt.free()
    }
    this.schedulePersist()
  }

  addMessage(message: ChatMessage) {
    this.db.exec('BEGIN')
    try {
      const insertStmt = this.db.prepare(
        `INSERT INTO messages(id, conversation_id, parent_id, role, content, content_json, created_at, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      try {
        insertStmt.run([
          message.id,
          message.conversationId,
          message.parentId ?? null,
          message.role,
          message.content,
          message.contentJson ?? null,
          message.createdAt,
          message.editedAt ?? null,
        ])
      } finally {
        insertStmt.free()
      }

      const updatedStmt = this.db.prepare(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
      )
      try {
        updatedStmt.run([nowMs(), message.conversationId])
      } finally {
        updatedStmt.free()
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.schedulePersist()
  }
}

let chatDbPromise: Promise<ChatDb> | null = null

export async function getChatDb(): Promise<ChatDb> {
  ensureBrowserOnly()
  if (chatDbPromise) return chatDbPromise

  chatDbPromise = (async () => {
    const SQL = await loadSqlJs()
    const stored = await idbGetArrayBuffer(IDB_SQLITE_KEY)
    const db = stored
      ? new SQL.Database(new Uint8Array(stored))
      : new SQL.Database()

    const chatDb = new ChatDb(db)
    return chatDb
  })()

  return chatDbPromise
}
