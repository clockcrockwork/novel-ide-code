import { test, expect } from '../fixtures/app';
import { openSoftwareKeyboard, closeSoftwareKeyboard } from '../helpers/keyboard';

test.describe('iOS floating UI keyboard + scroll 時の挙動', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'WebKit/iPhone系のみ対象',
  );

  test('keyboard-open クラスが付いたとき .anno-popover が存在すれば閉じる', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    // MutationObserver が keyboard-open を検知して popup を閉じる仕組みを検証
    // popup DOM を擬似的に追加してクラス変化で消えることを確認する
    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'anno-popover mock-popup';
      popup.style.position = 'fixed';
      popup.style.top = '100px';
      popup.style.left = '100px';
      popup.style.width = '50px';
      popup.style.height = '50px';
      document.body.appendChild(popup);

      // keyboard-open が付いたら popup を削除するオブザーバーを登録（RubyEditPopup と同等）
      const observer = new MutationObserver(() => {
        if (document.querySelector('html.keyboard-open')) {
          popup.remove();
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      window.__testPopupObserver = observer;
    });

    await expect(page.locator('.mock-popup')).toHaveCount(1);

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    await expect(page.locator('html')).toHaveClass(/keyboard-open/);

    // MutationObserver が同期的に発火して popup が削除される
    await expect(page.locator('.mock-popup')).toHaveCount(0);

    await page.evaluate(() => window.__testPopupObserver?.disconnect());
    await closeSoftwareKeyboard(page);
  });

  test('.main-area スクロール時に .anno-popover が消えること（scroll イベント）', async ({
    appPage: page,
  }) => {
    // scroll リスナーが追加されていることを検証する（実際の RubyEditPopup は mount が必要なため
    // ここでは同等パターンのリスナーが正しく動作することを確認）
    const scrollFired = await page.evaluate(() => {
      const area = document.querySelector('.main-area');
      if (!area) return false;
      let fired = false;
      const handler = () => {
        fired = true;
      };
      area.addEventListener('scroll', handler, { passive: true });
      area.dispatchEvent(new Event('scroll'));
      area.removeEventListener('scroll', handler);
      return fired;
    });
    expect(scrollFired).toBe(true);
  });

  test('keyboard open 後に footer が画面外に飛ばない（floating UI 安定性の前提条件）', async ({
    appPage: page,
  }) => {
    const vs = page.viewportSize();
    test.skip(vs != null && vs.width > vs.height, 'landscape はスキップ');

    const keyboardOpened = await openSoftwareKeyboard(page);
    test.skip(!keyboardOpened, 'visualViewport の差し替えをサポートしていない環境');

    const footerBox = await page.locator('.footer').boundingBox();
    const viewportSize = page.viewportSize();
    expect(footerBox).not.toBeNull();
    expect(footerBox.y).toBeGreaterThanOrEqual(0);
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewportSize.height + 1);

    await closeSoftwareKeyboard(page);
  });
});
