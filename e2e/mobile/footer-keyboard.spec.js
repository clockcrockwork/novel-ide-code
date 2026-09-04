import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

const pxToNumber = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

const readFooterState = (page) =>
  page.evaluate(() => {
    return {
      cover: getComputedStyle(document.documentElement).getPropertyValue('--footer-cover').trim(),
      vvOffset: getComputedStyle(document.documentElement)
        .getPropertyValue('--footer-vv-offset')
        .trim(),
    };
  });

test.describe('モバイルフッター追従', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('キーボード開閉時にfooter関連CSSが更新される', async ({ appPage: page }) => {
    const initialViewport = page.viewportSize() ?? { width: 390, height: 844 };
    await page.setViewportSize(initialViewport);
    await expect(page.locator('.footer')).toBeVisible();

    let before;
    await expect
      .poll(async () => {
        before = await readFooterState(page);
        return before.cover;
      })
      .toMatch(/px$/);

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('.footer')).toBeVisible();

    await expect.poll(() => readFooterState(page)).not.toEqual(before);

    const opened = await readFooterState(page);
    // footer は flex child のため bottom は変化しない。vv offset が増加して keyboard-open クラスが付く
    expect(pxToNumber(opened.vvOffset)).toBeGreaterThan(0);
    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    await closeSoftwareKeyboard(page);

    await expect.poll(() => readFooterState(page)).toEqual(before);
  });

  test('キーボード表示中もモードボタンとフッターが操作可能', async ({ appPage: page }) => {
    await expect(page.locator('.footer')).toBeVisible();

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('.footer')).toBeVisible();

    const modeButtons = page.locator('.mgrp').getByRole('button');
    await expect(modeButtons).toHaveCount(4);

    await page.locator('.mgrp').getByRole('button', { name: 'プレビュー', exact: true }).click();
    await expect(page.locator('.footer')).toBeVisible();

    await page.locator('.mgrp').getByRole('button', { name: '執筆', exact: true }).click();
    await expect(page.locator('.footer')).toBeVisible();
    await closeSoftwareKeyboard(page);
  });

  test('スクロール時（offsetTop > 0）でもフッターが正しく追従する', async ({ appPage: page }) => {
    await expect(page.locator('.footer')).toBeVisible();

    let before;
    await expect
      .poll(async () => {
        before = await readFooterState(page);
        return before.cover;
      })
      .toMatch(/px$/);

    const keyboardOpened = await openSoftwareKeyboard(page, { offsetTop: 10 });
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('.footer')).toBeVisible();
    await expect.poll(() => readFooterState(page)).not.toEqual(before);

    const opened = await readFooterState(page);
    // offsetTop > 0 でも vv offset が設定され keyboard-open が付くこと
    expect(pxToNumber(opened.vvOffset)).toBeGreaterThan(0);
    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    await closeSoftwareKeyboard(page);
    await expect.poll(() => readFooterState(page)).toEqual(before);
  });
});
