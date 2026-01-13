import { expect, test } from '@playwright/test'

const EPUB_BASE64 =
  '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'

function normalizeAnswer(text: string) {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeForRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstNWordsNormalized(text: string, n: number) {
  const words = normalizeAnswer(text)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
  return words.slice(0, n).join(' ')
}

test.describe('Gemini chat (integration)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('sets GEMINI_API_KEY via command palette and answers from selected passage', async ({
    page,
    context,
  }) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        'Missing GEMINI_API_KEY. Set it in `frontend/.env.playwright` (or env) to run Gemini E2E.',
      )
    }

    // Mock the backend book endpoints used by the home route.
    const apiBase = process.env.VITE_API_URL?.trim() || 'http://localhost:8080'
    const apiBaseRe = escapeForRegex(apiBase)
    const bookId = 'book_test_1'
    const bookFileUrl = `${apiBase}/books/${encodeURIComponent(bookId)}/file`

    await page.route('**/test/fixture.epub', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/epub+zip' },
        body: Buffer.from(EPUB_BASE64, 'base64'),
      })
    })

    await page.route(`${apiBase}/auth/me`, async (route) => {
      await route.fulfill({
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: 'null',
      })
    })

    await page.route(new RegExp(`^${apiBaseRe}/books/search\\?`), async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: bookId,
              url: '',
              title: 'MFV2 Test Book',
              authors: ['Test Author'],
              thumbnail_url: '',
              transformation_data: {},
              visibility: 'public',
              owner_user_id: null,
            },
          ],
          total: 1,
          limit: 50,
          next_cursor: null,
        }),
      })
    })

    await page.route(`${apiBase}/books/${bookId}`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: bookId,
          url: '',
          title: 'MFV2 Test Book',
          authors: ['Test Author'],
          thumbnail_url: '',
          transformation_data: {},
          visibility: 'public',
          owner_user_id: null,
        }),
      })
    })

    await page.route(new RegExp(`^${escapeForRegex(bookFileUrl)}(\\?.*)?$`), async (route) => {
      // Serve the same fixture body via the API URL expected by the home route.
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/epub+zip' },
        body: Buffer.from(EPUB_BASE64, 'base64'),
      })
    })

    // Preselect the book so the reader renders immediately.
    await context.addCookies([
      {
        name: 'selected-book-id',
        value: bookId,
        domain: 'localhost',
        path: '/',
      },
    ])

    // Vite dev (SSR) can keep the network busy; waiting for "load" is sometimes
    // flaky in headed debug runs. "domcontentloaded" is sufficient here.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('banner')).toBeVisible()

    const readerFrame = page.frameLocator('iframe.mfv2-reader__iframe')
    await expect(readerFrame.getByRole('heading', { name: 'Chapter 1' })).toBeVisible({
      timeout: 30_000,
    })

    // Open settings popover and click "Gemini API Key".
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: /Gemini API Key/i }).click()

    // Fill key and save.
    const keyInput = page.getByPlaceholder('Paste your GEMINI_API_KEY…')
    await expect(keyInput).toBeVisible()
    await keyInput.fill(process.env.GEMINI_API_KEY!)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Status:\s*saved/i)).toBeVisible()

    // Open chat panel.
    await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    await expect(page.getByTestId('chat-composer')).toBeVisible()

    // Select the intro sentence in the reader and add to chat via reader context menu.
    await readerFrame.locator('body').evaluate(() => {
      const el = document.querySelector('#intro')
      const node = el?.firstChild
      if (!el || !node || node.nodeType !== Node.TEXT_NODE) {
        throw new Error('#intro text missing')
      }
      const text = node.nodeValue ?? ''
      const start = Math.max(0, text.indexOf('This'))
      const end = Math.min(text.length, text.length)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const sel = window.getSelection()
      if (!sel) throw new Error('selection missing')
      sel.removeAllRanges()
      sel.addRange(range)
      document.body.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      )
    })

    const addToChat = page.locator('[role="menuitem"]', { hasText: 'Add to chat' })
    await expect(addToChat).not.toHaveAttribute('data-disabled', '')
    await addToChat.click()

    // Ensure the chip was inserted into the composer.
    await expect(page.getByTestId('chat-composer')).toContainText('@')

    const expected = 'This is a test EPUB'
    const prompt =
      'Repeat exactly the first five words of the selected passage, and nothing else.'

    // Type into the TipTap composer and press Enter to send.
    const composer = page.getByTestId('chat-composer').locator('.ProseMirror')
    await composer.click()
    await composer.type(prompt)
    await composer.press('Enter')

    // Wait for assistant message to appear and contain the expected phrase.
    const lastAssistant = page
      .locator('[data-testid="chat-message"][data-chat-role="assistant"]')
      .last()

    await expect(lastAssistant).toBeVisible({ timeout: 60_000 })
    await expect(lastAssistant).toContainText(/This/i, { timeout: 60_000 })

    const assistantText = await lastAssistant.innerText()
    expect(firstNWordsNormalized(assistantText, 5)).toBe(expected)
  })
})
