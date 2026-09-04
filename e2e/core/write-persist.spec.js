import { test, expect, DB_NAME, DB_VERSION } from '../fixtures/app';
import { filesContainText } from '../helpers/idbFiles';

test('入力内容がリロード後も保持される', async ({ appPage: page }) => {
  const editor = page.locator('.tiptap.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  const value = `Playwright永続化テスト-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.keyboard.type(value);

  await expect.poll(() => filesContainText(page, DB_NAME, DB_VERSION, value)).toBeTruthy();

  await page.reload();
  await expect(page.locator('.tiptap.ProseMirror').first()).toContainText(value);
});
