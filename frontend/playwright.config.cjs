const { defineConfig, devices } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

function loadDotEnvPlaywright() {
  const envPath = path.resolve(process.cwd(), '.env.playwright')
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadDotEnvPlaywright()

const apiUrl = (process.env.VITE_API_URL || '').trim() || 'http://localhost:8080'
const appUrl = 'http://localhost:3000'

module.exports = defineConfig({
  testDir: './e2e',
  // Vite dev SSR dep-optimization can be flaky under concurrent cold-start loads.
  // Keep E2E deterministic by running serially.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: appUrl,
    trace: 'on-first-retry',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Run E2E against a production build by default.
    // Enable test-only routes via `VITE_E2E=1` (kept out of real prod builds).
    command: `VITE_E2E=1 VITE_API_URL=${apiUrl} pnpm build && pnpm preview --port 3000 --strictPort`,
    url: appUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
