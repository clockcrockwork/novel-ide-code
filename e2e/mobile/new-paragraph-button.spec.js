import { test, expect } from '../fixtures/app';

const BUTTON_TITLE = '新しい段落を作成';

test.describe('新規段落ボタン', { tag: ['@editor-critical'] }, () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('PC幅では非表示になる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTitle(BUTTON_TITLE)).not.toBeVisible();
  });

  test('モバイル幅では表示される', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTitle(BUTTON_TITLE)).toBeVisible();
  });

  test('ボタンを押すと現在位置で段落が分割される', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const editor = page.locator('.tiptap.ProseMirror').first();

    // 最終段落にカーソルを明示的に置く。editor.click() は中央の段落へ
    // 移動し得るため、段落数から挿入位置を推測しない。
    await editor.locator(':scope > p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('前の文章');
    const before = await editor.evaluate((el) => el.querySelectorAll(':scope > p').length);

    await page.getByTitle(BUTTON_TITLE).click();

    await expect(editor.locator(':scope > p')).toHaveCount(before + 1);

    // 続きを入力して2つの段落に分かれていること
    await page.keyboard.insertText('後の文章');
    const paragraphs = editor.locator(':scope > p');
    await expect(paragraphs.nth(before - 1)).toContainText('前の文章');
    await expect(paragraphs.nth(before)).toContainText('後の文章');
  });

  test('IME composition中はボタンを押しても段落が分割されない', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const editor = page.locator('.tiptap.ProseMirror').first();

    await editor.click();
    await page.keyboard.insertText('変換前テキスト');

    const before = await editor.evaluate((el) => el.querySelectorAll(':scope > p').length);

    // IME 変換開始をシミュレート（ProseMirror が view.composing = true にする）
    await editor.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });

    await page.getByTitle(BUTTON_TITLE).click();

    // composition 中なので段落数は変化しないこと
    await expect(editor.locator(':scope > p')).toHaveCount(before);

    // 後片付け
    await editor.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
  });
});
