import { test, expect, DB_NAME, DB_VERSION } from '../fixtures/app';
import {
  generateLargeContent,
  injectLargeFile,
  readFileContent,
  PERF_FILE_ID,
} from '../helpers/largeContent';

const LARGE_CONTENT = generateLargeContent(300, 150);

test.describe(
  'IME composition テスト（300段落・大量コンテンツ）',
  { tag: ['@heavy', '@ime'] },
  () => {
    test.beforeEach(async ({ appPage: page }) => {
      await injectLargeFile(page, DB_NAME, DB_VERSION, LARGE_CONTENT);
      await page.reload();
      // hydrateFiles は非同期 → 大量コンテンツが DOM に表示されるまで待ってファイルロード完了を確認
      await expect(page.locator('.tiptap.ProseMirror').first()).toContainText('第1章', {
        timeout: 10000,
      });
    });

    test('日本語テキスト挿入後にリロードしてもコンテンツが保持される', async ({
      appPage: page,
    }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');

      const testText = `確認テスト${Date.now()}`;
      await page.keyboard.insertText(testText);

      // debounce 完了を待つ
      await page.waitForTimeout(700);

      const savedContent = await readFileContent(page, DB_NAME, DB_VERSION, PERF_FILE_ID);
      expect(savedContent).toContain(testText);

      // リロード後もコンテンツが保持される
      await page.reload();
      await expect(page.locator('.tiptap.ProseMirror').first()).toContainText(testText);
    });

    test('compositionstart → 入力 → compositionend でコンテンツが正しく保存される', async ({
      appPage: page,
    }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');

      // IME 変換開始をシミュレート
      await page.evaluate(() => {
        document
          .querySelector('.tiptap.ProseMirror')
          .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });

      // 変換中のテキスト入力
      const composingText = '変換テスト';
      await page.keyboard.insertText(composingText);

      // 変換確定をシミュレート（blur を伴わない compositionend）
      await page.evaluate((data) => {
        document
          .querySelector('.tiptap.ProseMirror')
          .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }));
      }, composingText);

      // debounce 完了を待つ
      await page.waitForTimeout(700);

      const savedContent = await readFileContent(page, DB_NAME, DB_VERSION, PERF_FILE_ID);
      expect(savedContent).toContain(composingText);
    });

    test('compositionstart 中に blur してもコンテンツがflushされる', async ({ appPage: page }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');

      // 先にテキストを入れておく（blur flush の検証用）
      const preText = `ブラー前テキスト${Date.now()}`;
      await page.keyboard.insertText(preText);
      await page.waitForTimeout(50);

      // compositionstart（変換中状態に入る）
      await page.evaluate(() => {
        document
          .querySelector('.tiptap.ProseMirror')
          .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });

      // 変換中追加入力
      await page.keyboard.insertText('ブラーテスト');

      // compositionend を送らずに blur → EditorBox の blur ハンドラが flush するはず
      await page.evaluate(() => {
        document.querySelector('.tiptap.ProseMirror').blur();
      });

      // debounce 完了を待つ
      await page.waitForTimeout(700);

      const savedContent = await readFileContent(page, DB_NAME, DB_VERSION, PERF_FILE_ID);
      // blur flush により両方のテキストが保存されていること
      expect(savedContent).toContain(preText);
      expect(savedContent).toContain('ブラーテスト');
    });

    test('300段落コンテンツで日本語連続入力しても画面表示が崩れない', async ({ appPage: page }) => {
      const editor = page.locator('.tiptap.ProseMirror').first();
      await editor.click();
      await page.keyboard.press('Control+End');

      // コンソールエラーがないこと（入力ループ前に登録して入力中のエラーを捕捉する）
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      // 日本語テキストを複数回挿入（各挿入間に composition イベントをシミュレート）
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          document
            .querySelector('.tiptap.ProseMirror')
            .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        });
        await page.keyboard.insertText(`日本語テスト${i}`);
        await page.evaluate((i) => {
          document
            .querySelector('.tiptap.ProseMirror')
            .dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: `日本語テスト${i}` }),
            );
        }, i);
      }

      // エラーなく入力が完了し、エディタが表示されていること
      await expect(editor).toBeVisible();
      await page.waitForTimeout(200);
      expect(consoleErrors.filter((e) => !e.includes('ResizeObserver'))).toHaveLength(0);
    });
  },
);
