import { test, expect } from '../fixtures/app';

async function pasteIntoEditor(page, { html, plain }) {
  const editor = page.locator('.tiptap.ProseMirror').first();
  await editor.click();
  await page.evaluate(
    ({ html, plain }) => {
      const dt = new DataTransfer();
      if (html) dt.setData('text/html', html);
      dt.setData('text/plain', plain ?? '');
      const el = document.querySelector('.tiptap.ProseMirror');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    },
    { html, plain },
  );
}

test.describe('クリップボード貼り付けセキュリティ', () => {
  test('script タグ付き HTML を貼り付けてもスクリプトが実行されない', async ({ appPage: page }) => {
    await pasteIntoEditor(page, {
      html: '<p>test</p><script>window.__xss_paste=true</script>',
      plain: 'test',
    });

    const fired = await page.evaluate(() => window.__xss_paste);
    expect(fired).toBeUndefined();
  });

  test('onerror 属性付き HTML を貼り付けてもイベントハンドラが残らない', async ({
    appPage: page,
  }) => {
    await pasteIntoEditor(page, {
      html: '<img src=x onerror="window.__xss_onerror=true">',
      plain: '',
    });

    const fired = await page.evaluate(() => window.__xss_onerror);
    expect(fired).toBeUndefined();
  });

  test('危険 HTML 貼り付け時にトーストが表示される', async ({ appPage: page }) => {
    await pasteIntoEditor(page, {
      html: '<p>ok</p><script>bad</script>',
      plain: 'ok',
    });

    await expect(page.locator('.toast-item')).toBeVisible({ timeout: 3000 });
  });

  test('javascript: リンクを含む HTML を貼り付けて href が除去される', async ({
    appPage: page,
  }) => {
    await pasteIntoEditor(page, {
      html: '<a href="javascript:alert(1)">click</a>',
      plain: 'click',
    });

    await expect(page.locator('.tiptap.ProseMirror a[href]')).toHaveCount(0);
  });

  test('記法を含むプレーンテキストを貼り付けると確認モーダルが表示される', async ({
    appPage: page,
  }) => {
    await pasteIntoEditor(page, {
      plain: '**太字テスト**',
    });

    await expect(page.locator('.modal')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('貼り付けの確認')).toBeVisible();
  });

  test('モーダルで「変換して貼り付け」を押すとテキストが挿入される', async ({ appPage: page }) => {
    await pasteIntoEditor(page, { plain: '**太字**' });

    await page.waitForSelector('.modal');
    await page.getByRole('button', { name: '変換して貼り付け' }).click();

    await expect(page.locator('.modal')).not.toBeVisible();
  });

  test('モーダルで「そのまま貼り付け」を押すとテキストが挿入される', async ({ appPage: page }) => {
    await pasteIntoEditor(page, { plain: '**そのまま**' });

    await page.waitForSelector('.modal');
    await page.getByRole('button', { name: 'そのまま貼り付け' }).click();

    await expect(page.locator('.modal')).not.toBeVisible();
    await expect(page.locator('.tiptap.ProseMirror')).toContainText('**そのまま**');
  });

  test('記法を含まない通常テキストはモーダルなしで挿入される', async ({ appPage: page }) => {
    await pasteIntoEditor(page, { plain: '普通のテキスト' });

    await expect(page.locator('.modal')).not.toBeVisible();
    await expect(page.locator('.tiptap.ProseMirror')).toContainText('普通のテキスト');
  });

  test('複数行テキストを貼り付けると改行が維持される', async ({ appPage: page }) => {
    await pasteIntoEditor(page, {
      html: '<p>line1</p><p>line2</p>',
      plain: 'line1\nline2',
    });

    const content = await page.locator('.tiptap.ProseMirror').textContent();
    expect(content).toContain('line1');
    expect(content).toContain('line2');
    // line1 と line2 が結合されて "line1line2" になっていないことを確認
    expect(content).not.toMatch(/line1line2/);
  });
});
