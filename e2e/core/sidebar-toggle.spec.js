import { test, expect } from '../fixtures/app';

/** サイドバー内ヘッダーの閉じるボタン。 */
function closeButton(page) {
  return page.getByTestId('sidebar-close-btn');
}

test.describe('サイドバー開閉', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('閉じたサイドバー内のボタンはプログラム的にフォーカスできない', async ({ page }) => {
    await expect(page.locator('.sidebar-scroll')).toBeHidden();

    const focusedAfter = await closeButton(page).evaluate((btn) => {
      btn.focus();
      return document.activeElement === btn;
    });

    expect(focusedAfter).toBe(false);
  });

  test('内部の × ボタンで閉じるとフォーカスがヘッダーのトグルボタンに戻る', async ({ page }) => {
    const toggleBtn = page.getByTitle('サイドバー');
    await toggleBtn.click();
    await expect(page.locator('.sidebar-scroll')).toBeVisible();

    await closeButton(page).click();

    await expect(page.locator('.sidebar-scroll')).toBeHidden();
    await expect(toggleBtn).toBeFocused();
  });

  test('閉じる直後、CSS の visibility 反転より先に inert がフォーカスを遮断する', async ({
    page,
  }) => {
    const toggleBtn = page.getByTitle('サイドバー');
    await toggleBtn.click();
    await expect(page.locator('.sidebar-scroll')).toBeVisible();

    // transition を意図的に引き伸ばし、inert 適用後も visibility が反転前であることを決定的にする。
    // 機構（visibility を transition 対象にしている・inert がフォーカスを切る）自体は変えず、
    // 観測窓の長さだけを伸ばす。
    await page.addStyleTag({ content: '.sidebar { transition-duration: 2s !important; }' });

    const result = await page.evaluate(async () => {
      const sidebar = document.getElementById('app-sidebar');
      const btn = document.querySelector('[data-testid="sidebar-close-btn"]');
      btn.click();
      // React の再描画完了タイミングは負荷依存のため固定フレーム数を待たず、
      // inert が実際に適用されるまで rAF ごとにポーリングする（デッドライン付き）。
      const deadline = performance.now() + 500;
      let frames = 0;
      while (!sidebar.inert && frames < 60 && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        frames += 1;
      }
      const inertApplied = sidebar.inert;
      const visibility = getComputedStyle(sidebar).visibility;
      btn.focus();
      return {
        inertApplied,
        visibility,
        focused: document.activeElement === btn,
      };
    });

    // inert が（ポーリングのデッドライン内に）適用され、かつその時点では
    // visibility がまだ反転前（visible）であること＝ inert が CSS 反転より先にフォーカスを遮断する因果を固定する
    expect(result.inertApplied).toBe(true);
    expect(result.visibility).toBe('visible');
    expect(result.focused).toBe(false);
  });
});
