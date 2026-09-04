import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

test.describe('iOS footer flex レイアウト', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('footer が position: fixed を持たない', async ({ appPage: page }) => {
    const position = await page.evaluate(
      () => getComputedStyle(document.querySelector('.footer')).position,
    );
    expect(position).not.toBe('fixed');
  });

  test('footer が flex item として app column の末尾に配置される', async ({ appPage: page }) => {
    const footerBox = await page.locator('.footer').boundingBox();
    const viewportSize = page.viewportSize();
    expect(footerBox).not.toBeNull();
    // footer の下端が viewport の高さ以内（画面外に消えていない）
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height + 1);
  });

  test('キーボードモック後も footer が viewport 内に残る', async ({ appPage: page }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    const footerBox = await page.locator('.footer').boundingBox();
    const viewportSize = page.viewportSize();
    expect(footerBox).not.toBeNull();
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height + 1);

    await closeSoftwareKeyboard(page);
  });

  test('キーボードモック後に window.scrollY が 0 のまま', async ({ appPage: page }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);

    await closeSoftwareKeyboard(page);
  });
});
