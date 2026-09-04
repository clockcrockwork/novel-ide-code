import { test, expect } from '../fixtures/app';

// モード切替ボタン（デスクトップ=ヘッダー .mgrp.hide-m、モバイル=フッター .mgrp）をクリックする
async function clickModeButton(page, label) {
  await page.locator('.mgrp').getByRole('button', { name: label, exact: true }).click();
}

async function getWidths(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.editor-container');
    const diffContainer = document.querySelector('.diff-container');
    const diffPanels = document.querySelectorAll('.diff-panel');
    return {
      viewport: window.innerWidth,
      editorContainer: container?.getBoundingClientRect().width ?? 0,
      diffContainer: diffContainer?.getBoundingClientRect().width ?? 0,
      diffPanel0: diffPanels[0]?.getBoundingClientRect().width ?? 0,
      diffPanel1: diffPanels[1]?.getBoundingClientRect().width ?? 0,
    };
  });
}

test.describe('差分ビュー・構成ビューのレイアウト幅', () => {
  test('差分モードで editor-container が 680px 制限を超えて画面幅いっぱいに広がる', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(isMobile, 'モバイルはモバイル専用テストで検証');
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    await clickModeButton(page, '差分');
    await expect(page.locator('.diff-container')).toBeVisible();

    const { viewport, editorContainer, diffContainer, diffPanel0, diffPanel1 } =
      await getWidths(page);

    // editor-container が 680px の幅制限を超えて全幅になっていること
    expect(editorContainer).toBeGreaterThan(700);
    // diff-container が editor-container のほぼ全幅を占めること（diff-wrapper の 8px padding × 2 分だけ狭い）
    expect(diffContainer).toBeGreaterThan(editorContainer - 30);
    // 左右パネルが同幅でかつ十分な幅を持つこと
    expect(Math.abs(diffPanel0 - diffPanel1)).toBeLessThan(5);
    expect(diffPanel0).toBeGreaterThan(300);
    // viewport の大部分を使っていること（80% 以上）
    expect(editorContainer / viewport).toBeGreaterThan(0.8);
  });

  test('差分モード → 執筆モードで通常の 680px 幅に戻る', async ({ page, baseURL, isMobile }) => {
    test.skip(isMobile, 'モバイルでは執筆モードも全幅のためスキップ');
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    await clickModeButton(page, '差分');
    await expect(page.locator('.diff-container')).toBeVisible();

    await clickModeButton(page, '執筆');
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    const { editorContainer } = await getWidths(page);
    // 執筆モードのデフォルト幅（680px）に戻っていること
    expect(editorContainer).toBeLessThanOrEqual(700);
  });

  test('差分 → 執筆 → 差分 を繰り返してもレイアウトが崩れない', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(isMobile, 'モバイルでは執筆モードも全幅のためスキップ');
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    for (let i = 0; i < 3; i++) {
      await clickModeButton(page, '差分');
      await expect(page.locator('.diff-container')).toBeVisible();
      const { editorContainer } = await getWidths(page);
      expect(editorContainer).toBeGreaterThan(700);

      await clickModeButton(page, '執筆');
      await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();
      const { editorContainer: writeWidth } = await getWidths(page);
      expect(writeWidth).toBeLessThanOrEqual(700);
    }
  });

  test('構成モードで editor-container が 680px 制限を超えて広がる', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(isMobile, 'モバイルはモバイル専用テストで検証');
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    await clickModeButton(page, '構成');
    await expect(page.locator('.main-area.structure-active')).toBeVisible();

    const { viewport, editorContainer } = await getWidths(page);
    // 構成モードも 680px 制限を超えること
    expect(editorContainer).toBeGreaterThan(700);
    // viewport の 80% 以上（左右 16px padding 分だけ狭い）
    expect(editorContainer / viewport).toBeGreaterThan(0.8);
  });

  test('モバイルで差分モードが全幅・両パネル均等に表示される', async ({
    page,
    baseURL,
    isMobile,
  }) => {
    test.skip(!isMobile, 'このテストはモバイル環境専用');
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

    await clickModeButton(page, '差分');
    await expect(page.locator('.diff-container')).toBeVisible();

    const { viewport, editorContainer, diffPanel0, diffPanel1 } = await getWidths(page);

    // viewport 幅いっぱいに広がること（90% 以上）
    expect(editorContainer / viewport).toBeGreaterThan(0.9);
    // 左右パネルが均等で最低限読める幅を持つこと
    expect(Math.abs(diffPanel0 - diffPanel1)).toBeLessThan(5);
    expect(diffPanel0).toBeGreaterThan(100);
  });
});
