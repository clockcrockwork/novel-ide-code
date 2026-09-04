import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

test.describe('iOS キーボード表示中スクロール', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('キーボードモック後もフッターが表示されたまま', async ({ appPage: page }) => {
    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('.footer')).toBeVisible();

    await closeSoftwareKeyboard(page);
  });

  test('main-area スクロール後もフッターが表示されたまま', async ({ appPage: page }) => {
    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    const mainArea = page.locator('.main-area');
    await mainArea.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await expect(page.locator('.footer')).toBeVisible();

    await closeSoftwareKeyboard(page);
  });

  test('キーボード閉じた後に --footer-vv-offset が 0px に戻る', async ({ appPage: page }) => {
    const getVvOffset = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--footer-vv-offset').trim(),
      );

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    // keyboard open 時は vv offset が正の値になる
    await expect.poll(async () => Number.parseFloat(await getVvOffset())).toBeGreaterThan(0);

    await closeSoftwareKeyboard(page);

    // keyboard close 後は 0px に戻る
    await expect.poll(getVvOffset).toBe('0px');
  });

  test('keyboard-open 時は sidebar の transition が抑制される', async ({ appPage: page }) => {
    const vs = page.viewportSize();
    test.skip(
      vs != null && vs.width > vs.height,
      'landscape は off=70px < KEYBOARD_THRESHOLD=120px のためスキップ',
    );
    const getSidebarTransition = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).transition);

    const transitionBefore = await getSidebarTransition();

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    const transitionDuring = await getSidebarTransition();
    // .sidebar は transition: width .22s ease, opacity .22s ease, visibility .22s ease を持つ
    // keyboard-open 中は transition: none に上書きされること（before との差分で検証）
    expect(transitionDuring).toMatch(/^(none|all 0s|0s)/);
    expect(transitionDuring).not.toBe(transitionBefore);

    await closeSoftwareKeyboard(page);
  });
});
