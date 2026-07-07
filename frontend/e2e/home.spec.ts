import { expect, test, type APIRequestContext } from '@playwright/test'

const apiUrl = process.env.VITE_API_URL?.trim() || 'http://localhost:8080'

async function backendHealthy(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get(`${apiUrl}/health`)
    return res.ok()
  } catch {
    return false
  }
}

test.describe('Home route (production build)', () => {
  test('loads public library, opens a book, uses TOC + chat chapter mentions', async ({
    page,
    request,
  }) => {
    const ok = await backendHealthy(request)
    test.skip(!ok, `Backend not reachable at ${apiUrl}`)

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('banner')).toBeVisible()

    const bookList = page.getByRole('region', { name: 'Book list' })
    await expect(bookList).toBeVisible()

    const empty = page.getByText('No books yet.')
    const error = page.getByText('Failed to load books.')
    const bookButtons = page.locator(
      '[role="region"][aria-label="Book list"] button',
    )

    await expect.poll(
      async () => {
        if ((await bookButtons.count()) > 0) return 'books'
        if (await empty.isVisible()) return 'empty'
        if (await error.isVisible()) return 'error'
        return 'loading'
      },
      { timeout: 30_000 },
    ).not.toBe('loading')

    if (await empty.isVisible()) {
      test.skip(true, 'No public books found (seed your backend and retry).')
    }
    if (await error.isVisible()) {
      throw new Error('Failed to load books from backend.')
    }

    const allBookButtons = await bookButtons.all()
    let firstBookButton: (typeof allBookButtons)[number] | null = null
    for (const button of allBookButtons) {
      const label = (await button.innerText()).trim()
      if (!/\bPDF\b/.test(label)) {
        firstBookButton = button
        break
      }
    }
    if (!firstBookButton) {
      test.skip(true, 'No public EPUB books found (seed your backend and retry).')
      return
    }
    const firstBookTitle = (await firstBookButton.innerText()).trim()
    expect(firstBookTitle).not.toBe('')

    // Search using the first book title (sanity check search input wiring).
    const searchInput = page.getByPlaceholder('Search title or author…')
    await searchInput.fill(
      firstBookTitle.slice(0, Math.min(12, firstBookTitle.length)),
    )
    await expect(
      page
        .locator('[role="region"][aria-label="Book list"] button')
        .first(),
    ).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(searchInput).toHaveValue('')

    // Select the book and wait for the reader to appear.
    await firstBookButton.click()
    const readerFrame = page.frameLocator('iframe.mfv2-reader__iframe')
    await expect(readerFrame.locator('body')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.mfv2-reader__pageIndicator')).toBeVisible()

    // Basic pagination via keyboard (ArrowRight should advance).
    const pageCurrent = page.locator('.mfv2-reader__pageIndicator strong').first()
    await readerFrame.locator('body').click()
    await expect(page.locator('.mfv2-reader__hud.is-visible')).toBeVisible()
    const before = (await pageCurrent.innerText()).trim()
    await page.keyboard.press('ArrowRight')
    await expect(pageCurrent).not.toHaveText(before, { timeout: 30_000 })

    // Open the reader TOC and navigate to a chapter if available.
    await readerFrame.locator('body').click()
    await expect(page.locator('.mfv2-reader__hud.is-visible')).toBeVisible()
    await page.locator('.mfv2-reader__topbarLeft .mfv2-reader__iconBtn').click()
    const tocPanel = page.locator('.mfv2-reader__tocPanel')
    await expect(tocPanel).toBeVisible()

    const tocEmpty = tocPanel.getByText('No table of contents found.')
    let chapterTitle: string | null = null
    let chapterIndex = 0

    if (!(await tocEmpty.isVisible())) {
      const tocItems = tocPanel.locator('button.mfv2-reader__tocItem')
      const count = await tocItems.count()
      if (count > 0) {
        chapterIndex = count > 1 ? 1 : 0
        const target = tocItems.nth(chapterIndex)
        chapterTitle = (await target.innerText()).trim() || null
        await target.click()
        await expect(tocPanel).toBeHidden()
      }
    } else {
      await page.keyboard.press('Escape')
      await expect(tocPanel).toBeHidden()
    }

    // Open chat and try inserting a chapter mention (only meaningful when TOC exists).
    await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    const composer = page.getByTestId('chat-composer').locator('.ProseMirror')
    await expect(composer).toBeVisible()

    if (chapterTitle) {
      await composer.click()
      await composer.type('@')
      const chapterMenu = page.getByText('References')
      await expect(chapterMenu).toBeVisible({ timeout: 10_000 })

      for (let i = 0; i < chapterIndex; i++) {
        await page.keyboard.press('ArrowDown')
      }
      await page.keyboard.press('Enter')

      const chip = page.locator('.mfv2-bookRef').first()
      await expect(chip).toBeVisible()

      // Clicking the chip should navigate the reader; verify by checking the active TOC item.
      await chip.click()
      await readerFrame.locator('body').click()
      await expect(page.locator('.mfv2-reader__hud.is-visible')).toBeVisible()
      await page.locator('.mfv2-reader__topbarLeft .mfv2-reader__iconBtn').click()
      await expect(tocPanel).toBeVisible()

      const active = tocPanel.locator('button.mfv2-reader__tocItem.is-active')
      await expect(active.first()).toBeVisible({ timeout: 30_000 })
    }
  })

  test('chat send without API key prompts settings', async ({ page, request }) => {
    const ok = await backendHealthy(request)
    test.skip(!ok, `Backend not reachable at ${apiUrl}`)

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('banner')).toBeVisible()

    await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    const composer = page.getByTestId('chat-composer').locator('.ProseMirror')
    await expect(composer).toBeVisible()

    await composer.click()
    await composer.type('Hello')
    await composer.press('Enter')

    await expect(
      page.getByText('Set your GEMINI_API_KEY in Settings to send messages.'),
    ).toBeVisible()
    await expect(page.getByText('AI (Gemini)')).toBeVisible()
    await expect(page.getByPlaceholder('Paste your GEMINI_API_KEY…')).toBeVisible()
  })

  test('toggle library panel button hides/shows the left panel', async ({
    page,
    request,
  }) => {
    const ok = await backendHealthy(request)
    test.skip(!ok, `Backend not reachable at ${apiUrl}`)

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('banner')).toBeVisible()

    const toggleLeft = page.getByRole('button', { name: 'Toggle library panel' })
    await expect(toggleLeft).toBeVisible()

    const leftPanelRegion = page.getByRole('region', { name: 'Book list' })
    await expect(leftPanelRegion).toBeVisible()

    await toggleLeft.click()
    await expect(toggleLeft).toHaveAttribute('aria-pressed', 'false')
    await expect(leftPanelRegion).toBeHidden()

    await toggleLeft.click()
    await expect(toggleLeft).toHaveAttribute('aria-pressed', 'true')
    await expect(leftPanelRegion).toBeVisible()
  })
})
