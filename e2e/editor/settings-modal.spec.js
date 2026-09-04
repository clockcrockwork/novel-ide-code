import { test, expect } from '../fixtures/app';

test.describe('設定モーダル', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('設定ボタンクリックでモーダルが開く', async ({ page }) => {
    await page.getByTitle('設定').click();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'キャンセル' })).toBeVisible();
  });

  test('キャンセルボタンでモーダルが閉じる', async ({ page }) => {
    await page.getByTitle('設定').click();
    await expect(page.getByRole('button', { name: 'キャンセル' })).toBeVisible();

    await page.getByRole('button', { name: 'キャンセル' }).click();

    await expect(page.getByRole('button', { name: '保存' })).not.toBeAttached();
  });

  test('×ボタンでモーダルが閉じる', async ({ page }) => {
    await page.getByTitle('設定').click();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible();

    await page.locator('.mclose').click();

    await expect(page.getByRole('button', { name: '保存' })).not.toBeAttached();
  });

  test('overlay クリックでモーダルが閉じる', async ({ page }) => {
    await page.getByTitle('設定').click();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible();

    // overlay 要素を直接クリック（モーダル外側）
    await page.locator('.overlay').click({ position: { x: 5, y: 5 } });

    await expect(page.getByRole('button', { name: '保存' })).not.toBeAttached();
  });

  test('保存ボタンでモーダルが閉じる', async ({ page }) => {
    await page.getByTitle('設定').click();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible();

    await page.getByRole('button', { name: '保存' }).click();

    await expect(page.getByRole('button', { name: '保存' })).not.toBeAttached();
  });

  test('フォント変更が保存後に保持される', async ({ page }) => {
    await page.getByTitle('設定').click();

    const select = page.getByLabel('フォント');
    await select.selectOption('noto-sans');

    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: '保存' })).not.toBeAttached();

    // リロード後も設定が維持されている
    await page.reload();
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });

    await page.getByTitle('設定').click();
    await expect(page.getByLabel('フォント')).toHaveValue('noto-sans');
  });
});
