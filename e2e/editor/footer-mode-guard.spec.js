import { test, expect } from '../fixtures/app';

async function clickModeButton(page, label) {
  await page.locator('.mgrp').getByRole('button', { name: label, exact: true }).click();
}

test.describe('フッター入力補助のモード別表示制御', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('執筆モードでは FormattingRow・NavigationRow が表示される', async ({ page }) => {
    await expect(page.getByTitle('ルビ（ふりがな）')).toBeVisible();
    await expect(page.getByTitle('カーソル左')).toBeVisible();
    await expect(page.getByTitle('元に戻す')).toBeVisible();
  });

  test('プレビューモードでは入力補助が非表示になる', async ({ page }) => {
    await clickModeButton(page, 'プレビュー');
    await expect(page.getByTitle('ルビ（ふりがな）')).not.toBeAttached();
    await expect(page.getByTitle('カーソル左')).not.toBeAttached();
    await expect(page.getByTitle('元に戻す')).not.toBeAttached();
  });

  test('差分モードでは入力補助が非表示になる', async ({ page }) => {
    await clickModeButton(page, '差分');
    await expect(page.getByTitle('ルビ（ふりがな）')).not.toBeAttached();
    await expect(page.getByTitle('カーソル左')).not.toBeAttached();
    await expect(page.getByTitle('元に戻す')).not.toBeAttached();
  });

  test('構成モードでは入力補助が非表示になる', async ({ page }) => {
    await clickModeButton(page, '構成');
    await expect(page.getByTitle('ルビ（ふりがな）')).not.toBeAttached();
    await expect(page.getByTitle('カーソル左')).not.toBeAttached();
    await expect(page.getByTitle('元に戻す')).not.toBeAttached();
  });

  test.describe('モード復帰で入力補助が再表示される', () => {
    for (const label of ['プレビュー', '差分', '構成']) {
      test(`${label} → 執筆 で再表示される`, async ({ page }) => {
        await clickModeButton(page, label);
        await expect(page.getByTitle('ルビ（ふりがな）')).not.toBeAttached();

        await clickModeButton(page, '執筆');
        await expect(page.getByTitle('ルビ（ふりがな）')).toBeVisible();
        await expect(page.getByTitle('カーソル左')).toBeVisible();
      });
    }
  });

  test.describe('モード切り替えボタンは全モードで常時操作可能', () => {
    for (const label of ['執筆', 'プレビュー', '差分', '構成']) {
      test(`${label}モードでもモード切り替えボタンが表示される`, async ({ page }) => {
        await clickModeButton(page, label);
        // getByRole でアクセシビリティツリー上の可視ボタンを取得し .mbtn.on クラスで絞り込む
        await expect(
          page.getByRole('button', { name: label, exact: true }).and(page.locator('.mbtn.on')),
        ).toBeVisible();
      });
    }
  });
});
