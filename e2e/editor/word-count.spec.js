import { test, expect } from '../fixtures/app';

async function openWordCount(page) {
  // サイドバーが閉じていれば開く
  const sidebarScroll = page.locator('.sidebar-scroll');
  if (!(await sidebarScroll.isVisible())) {
    await page.getByTitle('サイドバー').click();
  }
  await expect(sidebarScroll).toBeVisible({ timeout: 5000 });

  // 「文字数カウント」モジュールを展開
  const goalInput = page.locator('input[aria-label="目標文字数"]');
  const appeared = await goalInput
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.locator('.mod-header').filter({ hasText: '文字数カウント' }).click();
  }
  await expect(goalInput).toBeVisible({ timeout: 5000 });
}

/** "全 X 字" テキストから数値を取り出す */
async function getAllCount(page) {
  const text = await page
    .locator('.mod-body')
    .filter({ hasText: '空白除外' })
    .first()
    .locator('div')
    .filter({ hasText: /全.*字/ })
    .first()
    .textContent();
  const m = (text || '').replace(/,/g, '').match(/全\s*(\d+)\s*字/);
  return m ? parseInt(m[1], 10) : 0;
}

test.describe('文字数カウント', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
    await openWordCount(page);
  });

  test('本文入力に応じて文字数が増える', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();

    const before = await getAllCount(page);

    await editor.press('End');
    await editor.pressSequentially('あいうえおかきくけこ', { delay: 20 });

    await expect.poll(() => getAllCount(page), { timeout: 8000 }).toBeGreaterThan(before);
  });

  test('目標文字数を変更してリロード後も保持される', async ({ page }) => {
    const input = page.locator('input[aria-label="目標文字数"]');
    await input.fill('9999');
    await page.keyboard.press('Enter');
    await expect(page.getByText('保存しました')).toBeVisible({ timeout: 3000 });

    await page.reload();
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
    await openWordCount(page);

    await expect(page.locator('input[aria-label="目標文字数"]')).toHaveValue('9999');
  });
});
