import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

test.describe('iOS editor focus / scroll 制御', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('keyboard open 中に editor を focus しても window.scrollY が 0 のまま', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await page.locator('.ProseMirror').click();

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);

    await closeSoftwareKeyboard(page);
  });

  test('keyboard open 中に editor を focus しても footer の bounding box が viewport 内に残る', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await page.locator('.ProseMirror').click();

    // 2フレーム待機（justFocusedRef リセットと同じタイミング）
    await page.waitForTimeout(50);

    const footerBox = await page.locator('.footer').boundingBox();
    const viewportSize = page.viewportSize();
    expect(footerBox).not.toBeNull();
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height + 1);

    await closeSoftwareKeyboard(page);
  });

  test('keyboard close 後に --footer-cover が初期値に戻る', async ({ appPage: page }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const initial = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--footer-cover').trim(),
    );

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await closeSoftwareKeyboard(page);

    const restored = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--footer-cover').trim(),
    );
    expect(restored).toBe(initial);
  });
});
