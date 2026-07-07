import { expect, test, type Page } from '@playwright/test'

async function openPdfReader(page: Page) {
  await page.goto('/test/pdfreader?textLayer=1')
  await expect(page.locator('[data-pdf-page-index="0"] canvas')).toBeVisible()
  await expect(page.getByLabel('Page number')).toHaveValue('1')
  await expect(page.getByText('/ 5')).toBeVisible()
}

test('loads and renders page 1', async ({ page }) => {
  await openPdfReader(page)

  await expect(page.locator('[data-pdf-page-index="0"] canvas')).toBeVisible()
  await expect(page.getByLabel('Page number')).toHaveValue('1')
})

test('next and prev update the page indicator', async ({ page }) => {
  await openPdfReader(page)

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByLabel('Page number')).toHaveValue('2')

  await page.getByRole('button', { name: 'Prev', exact: true }).click()
  await expect(page.getByLabel('Page number')).toHaveValue('1')
})

test('jump to page works', async ({ page }) => {
  await openPdfReader(page)

  await page.getByLabel('Jump to page').fill('4')
  await page.getByRole('button', { name: 'Jump' }).click()
  await expect(page.getByLabel('Page number')).toHaveValue('4')
})

test('double spread shows two canvases', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openPdfReader(page)
  await page.getByLabel('Jump to page').fill('2')
  await page.getByRole('button', { name: 'Jump' }).click()
  await expect(page.getByLabel('Page number')).toHaveValue('2')

  await page.getByRole('button', { name: /^Spread: auto$/ }).click()
  await page.getByRole('button', { name: /^Spread: single$/ }).click()

  await expect(
    page.getByRole('button', { name: /^Spread: double$/ }),
  ).toBeVisible()
  await expect(
    page.locator('[data-pdf-page-index]:not(.opacity-0) canvas'),
  ).toHaveCount(2)
})

test('getVisiblePage dump shows non-empty text', async ({ page }) => {
  await openPdfReader(page)

  const dump = page.locator('pre')
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: 'Dump visible' }).click()
      return dump.innerText()
    })
    .toMatch(/"label": "getVisiblePage"[\s\S]*"text":\s*"[^"]{10,}/)
})
