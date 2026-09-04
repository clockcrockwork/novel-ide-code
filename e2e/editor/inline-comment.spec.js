import { test, expect, DB_NAME, DB_VERSION } from '../fixtures/app';

async function waitForIDBContent(page, expected) {
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ dbName, dbVersion, expected }) => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, dbVersion);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB open blocked'));
          });
          try {
            const files = await new Promise((resolve, reject) => {
              const tx = db.transaction('files', 'readonly');
              const req = tx.objectStore('files').getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            return files.some((f) => (f.content || '').includes(expected));
          } finally {
            db.close();
          }
        },
        { dbName: DB_NAME, dbVersion: DB_VERSION, expected },
      ),
    )
    .toBeTruthy();
}

test.describe('インラインコメント記法', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('複数行 /*foo\\nbar*/ のラウンドトリップ — リロード後もコメントスパンが保持される', async ({
    page,
  }) => {
    const marker = `ic${Date.now()}`;
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');

    // /*{marker}foo → Shift+Enter → {marker}bar*/ の順で入力
    await editor.pressSequentially(`/*${marker}foo`, { delay: 30 });
    await editor.press('Shift+Enter');
    await editor.pressSequentially(`${marker}bar*/`, { delay: 30 });

    // IDB に /*{marker}foo\n{marker}bar*/ が書き込まれるまで待機してからリロード
    await waitForIDBContent(page, `/*${marker}foo\n${marker}bar*/`);
    await page.reload();

    // リロード後、inlineComment mark が適用されてスパンが描画されること
    const commentSpans = page.locator('.tiptap.ProseMirror .hl-comment');
    await expect(commentSpans.first()).toBeVisible({ timeout: 15000 });
    // "foo" と "bar" の両方のスパンが存在する
    await expect(
      page.locator('.tiptap.ProseMirror .hl-comment', { hasText: new RegExp(marker + 'foo') }),
    ).toBeVisible();
    await expect(
      page.locator('.tiptap.ProseMirror .hl-comment', { hasText: new RegExp(marker + 'bar') }),
    ).toBeVisible();
  });

  test('Shift+Enter による通常 hardBreak が CustomHardBreak 差し替え後も機能する', async ({
    page,
  }) => {
    const marker = `hb${Date.now()}`;
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await editor.press('End');

    await editor.pressSequentially(`前${marker}`, { delay: 30 });
    await editor.press('Shift+Enter');
    await editor.pressSequentially(`後${marker}`, { delay: 30 });

    // IDB に改行を含んだ内容が書き込まれるまで待機してからリロード
    await waitForIDBContent(page, `前${marker}\n後${marker}`);
    await page.reload();

    const reloaded = page.locator('.tiptap.ProseMirror').first();
    await expect(reloaded).toBeVisible({ timeout: 15000 });
    await expect(reloaded).toContainText(`前${marker}`);
    await expect(reloaded).toContainText(`後${marker}`);
    // コメントスパンが付いていないこと（通常テキストとして描画）
    await expect(
      page.locator(`.tiptap.ProseMirror .hl-comment`, { hasText: marker }),
    ).not.toBeVisible();
  });
});
