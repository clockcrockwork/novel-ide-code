import { test, expect } from '../fixtures/app';

test.describe('プレビューモード XSS 防御', () => {
  async function switchToPreview(page) {
    await page.getByRole('button', { name: 'プレビュー' }).click();
    await page.waitForSelector('.preview-area');
  }

  test('script タグはプレビューで実行されない', async ({ appPage: page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await page.keyboard.type('<script>window.__xss_test=true</script>');

    await switchToPreview(page);

    const fired = await page.evaluate(() => window.__xss_test);
    expect(fired).toBeUndefined();
    await expect(page.locator('.preview-area script')).toHaveCount(0);
  });

  test('img onerror XSS がプレビューで実行されない', async ({ appPage: page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await page.keyboard.type('<img src=x onerror="window.__xss_img=true">');

    await switchToPreview(page);

    const fired = await page.evaluate(() => window.__xss_img);
    expect(fired).toBeUndefined();
    await expect(page.locator('.preview-area [onerror]')).toHaveCount(0);
  });

  test('SVG onload XSS がプレビューで実行されない', async ({ appPage: page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();
    await page.keyboard.type('<svg onload="window.__xss_svg=true">');

    await switchToPreview(page);

    const fired = await page.evaluate(() => window.__xss_svg);
    expect(fired).toBeUndefined();
    await expect(page.locator('.preview-area [onload]')).toHaveCount(0);
  });
});
