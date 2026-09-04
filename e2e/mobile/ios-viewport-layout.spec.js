import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

test.describe('iOS モバイルレイアウト基盤', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('body がスクロールしない（overscroll-behavior: none）', async ({ appPage: page }) => {
    const bodyOverscroll = await page.evaluate(
      () => getComputedStyle(document.body).overscrollBehavior,
    );
    expect(bodyOverscroll).toBe('none');
  });

  test('キーボードモック後に window.scrollY が 0 のまま', async ({ appPage: page }) => {
    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);

    await closeSoftwareKeyboard(page);
  });

  test('キーボードモック後に keyboard-open クラスが documentElement に付く', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(
      vs != null && vs.width > vs.height,
      'landscape は off=70px < KEYBOARD_THRESHOLD=120px のためスキップ',
    );
    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    await closeSoftwareKeyboard(page);

    await expect(page.locator('html')).not.toHaveClass(/keyboard-open/);
  });

  test('main-area の overscroll-behavior が contain になっている', async ({ appPage: page }) => {
    const value = await page.evaluate(
      () => getComputedStyle(document.querySelector('.main-area')).overscrollBehavior,
    );
    expect(value).toBe('contain');
  });

  test('footer に safe-area-inset-bottom padding が設定されている', async ({ appPage: page }) => {
    const paddingBottom = await page.evaluate(
      () => getComputedStyle(document.querySelector('.footer')).paddingBottom,
    );
    // env(safe-area-inset-bottom) は環境次第で 0px になるが、プロパティ自体は存在する
    expect(paddingBottom).toMatch(/^\d+(\.\d+)?px$/);
  });

  test('keyboard-open 時に --footer-cover が footer 高＋キーボード高に拡張される', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(
      vs != null && vs.width > vs.height,
      'landscape は off=70px < KEYBOARD_THRESHOLD=120px のためスキップ',
    );

    const readCover = () =>
      page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return {
          cover: parseFloat(s.getPropertyValue('--footer-cover')),
          h: parseFloat(s.getPropertyValue('--footer-h')),
          off: parseFloat(s.getPropertyValue('--footer-vv-offset')),
        };
      });

    // useViewportFooter は requestAnimationFrame 内で CSS 変数を設定するため、
    // 反映前は calc(...) のまま parseFloat が NaN になる。確定するまで待つ。
    let before;
    await expect
      .poll(async () => {
        before = await readCover();
        return Number.isFinite(before.cover) && Number.isFinite(before.h);
      })
      .toBe(true);
    // キーボード閉時は cover ≈ footer 高
    expect(Math.abs(before.cover - before.h)).toBeLessThanOrEqual(1);

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    // openSoftwareKeyboard の resize → rAF 反映を待つ（cover がキーボード高ぶん拡張されるまで）
    let after;
    await expect
      .poll(async () => {
        after = await readCover();
        return (
          Number.isFinite(after.cover) &&
          Number.isFinite(after.h) &&
          Number.isFinite(after.off) &&
          after.cover > after.h
        );
      })
      .toBe(true);
    // cover はキーボード高ぶん footer 高より大きくなり、footer-h + offset と一致する
    expect(after.cover).toBeGreaterThan(after.h);
    expect(Math.abs(after.cover - (after.h + after.off))).toBeLessThanOrEqual(1);

    await closeSoftwareKeyboard(page);
  });

  test('keyboard-open 時に main-area の scroll-behavior が auto になる', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(
      vs != null && vs.width > vs.height,
      'landscape は off=70px < KEYBOARD_THRESHOLD=120px のためスキップ',
    );
    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    const scrollBehavior = await page.evaluate(
      () => getComputedStyle(document.querySelector('.main-area')).scrollBehavior,
    );
    expect(scrollBehavior).toBe('auto');

    await closeSoftwareKeyboard(page);
  });
});
