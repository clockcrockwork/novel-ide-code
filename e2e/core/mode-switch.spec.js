import { test, expect } from '../fixtures/app';

async function clickModeButton(page, label) {
  await page.locator('.mgrp').getByRole('button', { name: label, exact: true }).click();
}

test.describe('モード切替でエディタ内容が保持される', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  for (const mode of ['プレビュー', '差分', '構成']) {
    test(`執筆 → ${mode} → 執筆 でコンテンツが消えない`, async ({ page }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      const marker = `modesw${Date.now()}`;

      // エディタにフォーカスして末尾に移動してからタイプ
      await editor.click();
      await editor.press('End');
      await editor.pressSequentially(marker, { delay: 30 });
      await expect(editor).toContainText(marker, { timeout: 5000 });

      await clickModeButton(page, mode);
      await expect(editor).not.toBeVisible();

      await clickModeButton(page, '執筆');
      await expect(editor).toBeVisible();
      await expect(editor).toContainText(marker);
    });
  }

  test('複数モード連続切り替え後もコンテンツが保持される', async ({ page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    const marker = `multimode${Date.now()}`;

    await editor.click();
    await editor.press('End');
    await editor.pressSequentially(marker, { delay: 30 });
    await expect(editor).toContainText(marker, { timeout: 5000 });

    // プレビュー → 差分 → 構成 → 執筆 の連続切り替え
    await clickModeButton(page, 'プレビュー');
    await clickModeButton(page, '差分');
    await clickModeButton(page, '構成');
    await clickModeButton(page, '執筆');

    await expect(editor).toBeVisible();
    await expect(editor).toContainText(marker);
  });
});
