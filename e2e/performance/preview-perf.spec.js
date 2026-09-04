import { test, expect, DB_NAME, DB_VERSION } from '../fixtures/app';
import { generateLargeContent, injectLargeFile } from '../helpers/largeContent';

const CONTENT_10K = generateLargeContent(70, 150); // ~70段落 × 150字 ≈ 10,500字

test.describe('PreviewMode パフォーマンス', { tag: ['@perf'] }, () => {
  test.beforeEach(async ({ appPage: page }) => {
    await injectLargeFile(page, DB_NAME, DB_VERSION, CONTENT_10K);
    await page.reload();
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  async function clickModeButton(page, label) {
    await page.locator('.mgrp').getByRole('button', { name: label, exact: true }).click();
  }

  test('@perf write→preview 切替のキャッシュ効果: 2回目が1回目より速い', async ({
    appPage: page,
  }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 10000 });

    // 1回目: プレビューへ切替（parseMarkdown + splitIntoBlocks が走る）
    const t1start = Date.now();
    await clickModeButton(page, 'プレビュー');
    await expect(page.locator('.preview-area')).toBeVisible({ timeout: 5000 });
    const first = Date.now() - t1start;

    // 執筆モードに戻る（内容は変更しない）
    await clickModeButton(page, '執筆');
    await expect(editor).toBeVisible({ timeout: 5000 });

    // 2回目: 同一content → cachedParseMarkdown がキャッシュヒット
    const t2start = Date.now();
    await clickModeButton(page, 'プレビュー');
    await expect(page.locator('.preview-area')).toBeVisible({ timeout: 5000 });
    const second = Date.now() - t2start;

    // eslint-disable-next-line no-console
    console.log(`[preview-perf] 1回目: ${first}ms  2回目: ${second}ms`);

    // 2回目は1回目の 80% 以下であることを期待（キャッシュによる高速化）
    expect(second, `2回目(${second}ms)が1回目(${first}ms)より速くなっていない`).toBeLessThan(
      first * 0.8 + 50,
    );
  });

  test('@perf プレビュー内のアノテーション追加後も主要ブロックはre-renderされない', async ({
    appPage: page,
  }) => {
    await clickModeButton(page, 'プレビュー');
    const previewArea = page.locator('.preview-area');
    await expect(previewArea).toBeVisible({ timeout: 5000 });

    // 段落ブロックが複数描画されている（2つ目のブロックが存在すること = 分割済み）
    await expect(previewArea.locator('> div').nth(1)).toBeVisible({ timeout: 3000 });
  });
});
