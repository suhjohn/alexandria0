declare module 'sql.js' {
  export type SqlJsStatic = {
    Database: new (data?: Uint8Array) => {
      exec: (sql: string) => unknown
      export: () => Uint8Array
      prepare: (sql: string) => {
        bind: (params: Array<unknown>) => void
        run: (params?: Array<unknown>) => void
        step: () => boolean
        getAsObject: () => Record<string, unknown>
        free: () => void
      }
    }
  }

  export default function initSqlJs(config: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}

declare module 'sql.js/dist/sql-wasm.wasm?url' {
  const url: string
  export default url
}
