import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(
  new URL('../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url),
)
const destinationPath = fileURLToPath(
  new URL('../public/sql.js/dist/sql-wasm.wasm', import.meta.url),
)

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const sourceStat = await stat(sourcePath).catch(() => null)
if (!sourceStat) {
  throw new Error(
    `Missing sql.js WASM at ${sourcePath}. Did you run "pnpm install" in frontend?`,
  )
}

await mkdir(dirname(destinationPath), { recursive: true })

const destinationStat = await stat(destinationPath).catch(() => null)
const shouldCopy =
  !destinationStat ||
  destinationStat.size !== sourceStat.size ||
  destinationStat.mtimeMs < sourceStat.mtimeMs
if (shouldCopy) {
  await copyFile(sourcePath, destinationPath)
}
