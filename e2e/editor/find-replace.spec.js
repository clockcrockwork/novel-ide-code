import { test, expect } from '../fixtures/app';

async function openFindReplace(page) {
  // サイドバーが閉じていれば開く
  const sidebarScroll = page.locator('.sidebar-scroll');
  if (!(await sidebarScroll.isVisible())) {
    await page.getByTitle('サイドバー').click();
  }
  await expect(sidebarScroll).toBeVisible({ timeout: 5000 });

  // 「検索 & 置換」モジュールを展開
  const searchInput = page.getByPlaceholder('検索…');
  if (!(await searchInput.isVisible())) {
    await page.locator('.mod-header').filter({ hasText: '検索 & 置換' }).click();
  }
  await expect(searchInput).toBeVisible({ timeout: 3000 });
}

/** 検索入力の右側に表示される件数 span（ボタンの "1件" とは区別） */
function countSpan(page) {
  return page.getByTestId('find-count');
}

test.describe('検索・置換', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
    await openFindReplace(page);
  });

  test('検索ワード入力でヒット件数が表示される', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');
    await editor.pressSequentially('テストワードXYZ', { delay: 20 });
    // editor にコンテンツが反映されるまで待つ
    await expect(editor).toContainText('テストワードXYZ', { timeout: 5000 });

    await page.getByPlaceholder('検索…').fill('テストワードXYZ');

    await expect(countSpan(page)).toContainText('1件', { timeout: 5000 });
  });

  test('検索ワードがないときは件数が表示されない', async ({ page }) => {
    await page.getByPlaceholder('検索…').fill('');
    await expect(countSpan(page)).not.toBeAttached();
  });

  test('1件置換でテキストが1件だけ置換される', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');
    await editor.pressSequentially('置換テストAAA 置換テストAAA', { delay: 20 });
    await expect(editor).toContainText('置換テストAAA', { timeout: 5000 });

    await page.getByPlaceholder('検索…').fill('置換テストAAA');
    await expect(countSpan(page)).toContainText('2件', { timeout: 5000 });

    await page.getByPlaceholder('置換後…').fill('BBB');
    await page.getByRole('button', { name: '1件' }).click();

    await expect(countSpan(page)).toContainText('1件', { timeout: 5000 });
  });

  test('すべて置換でテキストが全件置換される', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');
    await editor.pressSequentially('置換全体CCC 置換全体CCC 置換全体CCC', { delay: 20 });
    await expect(editor).toContainText('置換全体CCC', { timeout: 5000 });

    await page.getByPlaceholder('検索…').fill('置換全体CCC');
    await expect(countSpan(page)).toContainText('3件', { timeout: 5000 });

    await page.getByPlaceholder('置換後…').fill('DDD');
    await page.getByRole('button', { name: 'すべて' }).click();

    // 全置換後は0件になる（検索ワードが残るためspanは存在するが "0件" を表示）
    await expect(countSpan(page)).toContainText('0件', { timeout: 5000 });
  });

  test('大文字小文字チェックのON/OFFで件数が変わる', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');
    await editor.pressSequentially('Abcdef abcdef', { delay: 20 });
    await expect(editor).toContainText('Abcdef', { timeout: 5000 });

    await page.getByPlaceholder('検索…').fill('abcdef');
    // 大文字小文字無視では2件
    await expect(countSpan(page)).toContainText('2件', { timeout: 5000 });

    // 大文字小文字を区別すると1件
    await page.getByLabel('大文字小文字').check();
    await expect(countSpan(page)).toContainText('1件', { timeout: 5000 });

    // チェックを外すと2件に戻る
    await page.getByLabel('大文字小文字').uncheck();
    await expect(countSpan(page)).toContainText('2件', { timeout: 5000 });
  });
});
