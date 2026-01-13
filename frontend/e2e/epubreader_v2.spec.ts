import { expect, test } from '@playwright/test'

const EPUB_BASE64 =
  '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'

test('EpubReaderV2 loads an EPUB and paginates', async ({ page }) => {
  await page.route('**/test/fixture.epub', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/epub+zip',
      },
      body: Buffer.from(EPUB_BASE64, 'base64'),
    })
  })

  await page.goto('/test/reader')

  const frame = page.frameLocator('iframe.mfv2-reader__iframe')
  await expect(frame.getByRole('heading', { name: 'Chapter 1' })).toBeVisible()

  const currentPage = page.locator('.mfv2-reader__pageIndicator strong').first()
  await expect(currentPage).toHaveText('1')

  await expect(page.getByTestId('reader-test-visible-text')).not.toHaveText('')
  await frame.locator('body').click()
  await page.keyboard.press('ArrowRight')
  await expect(currentPage).toHaveText('2')
  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=1')

  await page.keyboard.press('ArrowLeft')
  await expect(currentPage).toHaveText('1')
  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=0')
})

test('selection → add to chat → navigate away → chip navigates back', async ({
  page,
}) => {
  await page.route('**/test/fixture.epub', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/epub+zip',
      },
      body: Buffer.from(EPUB_BASE64, 'base64'),
    })
  })

  await page.goto('/test/reader')

  const frame = page.frameLocator('iframe.mfv2-reader__iframe')
  await expect(frame.getByRole('heading', { name: 'Chapter 1' })).toBeVisible()
  await expect(page.getByTestId('reader-test-visible-text')).not.toHaveText('')

  // Programmatically select a substring, then open the reader context menu.
  await frame.locator('body').evaluate(() => {
    const el = document.querySelector('#intro')
    const node = el?.firstChild
    if (!el || !node || node.nodeType !== Node.TEXT_NODE) {
      throw new Error('#intro text missing')
    }
    const text = node.nodeValue ?? ''
    const start = Math.max(0, text.indexOf('test EPUB'))
    const end = Math.min(text.length, start + 'test EPUB for MFV2'.length)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const sel = window.getSelection()
    if (!sel) throw new Error('selection missing')
    sel.removeAllRanges()
    sel.addRange(range)
  })

  await frame.locator('body').evaluate(() => {
    const evt = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
    })
    document.body.dispatchEvent(evt)
  })

  const addToChat = page.locator('[role="menuitem"]', { hasText: 'Add to chat' })
  await expect(addToChat).not.toHaveAttribute('data-disabled', '')
  await addToChat.click()
  await expect(page.getByTestId('reader-test-chip')).toBeVisible()

  const currentPage = page.locator('.mfv2-reader__pageIndicator strong').first()
  await expect(currentPage).toHaveText('1')
  await frame.locator('body').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(currentPage).toHaveText('3')
  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=2')

  await page.getByTestId('reader-test-chip').click()
  await expect(currentPage).toHaveText('1')
  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=0')
  await expect(page.getByTestId('reader-test-visible-text')).toContainText(
    'This is a test EPUB for MFV2.',
  )
})

test('page N → page N+1 keeps paragraph continuity', async ({ page }) => {
  await page.route('**/test/fixture.epub', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/epub+zip',
      },
      body: Buffer.from(EPUB_BASE64, 'base64'),
    })
  })

  await page.goto('/test/reader')
  const frame = page.frameLocator('iframe.mfv2-reader__iframe')
  await expect(frame.getByRole('heading', { name: 'Chapter 1' })).toBeVisible()

  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=0')
  const visible1 = await page.getByTestId('reader-test-visible-text').innerText()
  await frame.locator('body').click()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.mfv2-reader__pageIndicator strong').first()).toHaveText(
    '2',
  )
  await expect(page.getByTestId('reader-test-page')).toContainText('pageIndex=1')
  const visible2 = await page.getByTestId('reader-test-visible-text').innerText()

  const nums1 = Array.from(visible1.matchAll(/\((\d+)\)/g)).map((m) =>
    Number(m[1]),
  )
  const nums2 = Array.from(visible2.matchAll(/\((\d+)\)/g)).map((m) =>
    Number(m[1]),
  )
  expect(nums1.length).toBeGreaterThan(0)
  expect(nums2.length).toBeGreaterThan(0)

  const max1 = Math.max(...nums1)
  expect(nums2.some((n) => n >= max1)).toBe(true)
  expect(nums2.some((n) => n >= max1 + 1)).toBe(true)
  const nextMarker = Math.min(...nums2.filter((n) => n >= max1))
  expect(nextMarker).toBeLessThanOrEqual(max1 + 1)
})
