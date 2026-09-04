import { test, expect, DB_NAME, DB_VERSION } from '../fixtures/app';
import {
  generateLargeContent,
  injectLargeFile,
  enableWritingRules,
  readFileUpdatedAt,
  PERF_FILE_ID,
} from '../helpers/largeContent';

const LARGE_CONTENT = generateLargeContent(300, 150);

test.describe(
  '入力レイテンシ回帰テスト（300段落・大量コンテンツ）',
  { tag: ['@heavy', '@perf'] },
  () => {
    test.beforeEach(async ({ appPage: page }) => {
      await injectLargeFile(page, DB_NAME, DB_VERSION, LARGE_CONTENT);
      await page.reload();
      // hydrateFiles は非同期 → 大量コンテンツが DOM に表示されるまで待ってファイルロード完了を確認
      await expect(page.locator('.tiptap.ProseMirror').first()).toContainText('第1章', {
        timeout: 10000,
      });
    });

    test('30ストローク連打でlongtask(>100ms)が発生しない', async ({ appPage: page }) => {
      // PerformanceObserver longtask は Chromium でのみ利用可能
      const supported = await page.evaluate(
        () =>
          typeof PerformanceObserver !== 'undefined' &&
          PerformanceObserver.supportedEntryTypes?.includes('longtask'),
      );
      test.skip(!supported, 'longtask entryType 非対応環境');

      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');
      // Ctrl+End on 300-para doc can itself cause a longtask; wait for scroll to settle
      await page.waitForTimeout(300);

      await page.evaluate(() => {
        window.__longTasks = [];
        try {
          new PerformanceObserver((list) => {
            window.__longTasks.push(
              ...list.getEntries().map((e) => ({
                name: e.name,
                duration: Math.round(e.duration),
              })),
            );
          }).observe({ entryTypes: ['longtask'] });
        } catch {}
      });

      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('a');
      }
      await page.waitForTimeout(600);

      const longTasks = await page.evaluate(() => window.__longTasks || []);
      const heavy = longTasks.filter((t) => t.duration > 100);
      expect(
        heavy,
        `longtask(>100ms) が ${heavy.length} 件発生:\n${JSON.stringify(heavy, null, 2)}`,
      ).toHaveLength(0);
    });

    test('IDB書き込みが連打後にdebounceされ最終的に保存される', async ({ appPage: page }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');

      // 10 ストロークを打つ
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('b');
      }

      // 最終ストローク後 600ms 待機 → debounce 完了 → IDB 更新済み
      await page.waitForTimeout(600);
      const afterAt = await readFileUpdatedAt(page, DB_NAME, DB_VERSION, PERF_FILE_ID);
      // 注入時の固定値 1000000 より大きい → 実際の書き込みが発生したことを確認
      expect(afterAt).toBeGreaterThan(1000000);
    });

    test('WritingRules有効・Markdown混在コンテンツで30ストロークにlongtaskが発生しない', async ({
      appPage: page,
    }) => {
      const supported = await page.evaluate(
        () =>
          typeof PerformanceObserver !== 'undefined' &&
          PerformanceObserver.supportedEntryTypes?.includes('longtask'),
      );
      test.skip(!supported, 'longtask entryType 非対応環境');

      await enableWritingRules(page, DB_NAME, DB_VERSION);
      await page.reload();
      await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible();

      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(300);

      await page.evaluate(() => {
        window.__longTasks = [];
        try {
          new PerformanceObserver((list) => {
            window.__longTasks.push(
              ...list.getEntries().map((e) => ({ duration: Math.round(e.duration) })),
            );
          }).observe({ entryTypes: ['longtask'] });
        } catch {}
      });

      // 括弧直後に入力（bracket_sp ルール対象）
      await page.keyboard.type('（');
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('a');
      }
      await page.waitForTimeout(600);

      const longTasks = await page.evaluate(() => window.__longTasks || []);
      const heavy = longTasks.filter((t) => t.duration > 100);
      expect(
        heavy,
        `WritingRules有効時にlongtask(>100ms) が ${heavy.length} 件:\n${JSON.stringify(heavy, null, 2)}`,
      ).toHaveLength(0);
    });
  },
);
