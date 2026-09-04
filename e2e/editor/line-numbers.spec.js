import { test, expect } from '../fixtures/app';

// 行番号を有効化してページを開き、プライマリエディタをクリアした状態にするヘルパー。
// 戻り値: { editor, gutterItems } — どちらもプライマリペインにスコープ済み。
async function setup(page, baseURL) {
  await page.addInitScript(() => {
    localStorage.setItem('ide_linenos', 'true');
  });
  await page.goto(baseURL);

  const editor = page.locator('.tiptap.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  // 既存コンテンツを全選択して削除
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  // .editor-write-shell はガターと本文の共通親。first() でプライマリペインに限定する。
  const shell = page.locator('.editor-write-shell').first();
  const gutterItems = shell.locator('.line-number-gutter .line-number');

  // 空エディタで 1 行になるまで待つ
  await expect(gutterItems).toHaveCount(1);

  return { editor, gutterItems };
}

test.describe('行番号表示', () => {
  test('ケースA: 多行本文でスクロール後も行番号が欠落しない', async ({ page, baseURL }) => {
    const { editor, gutterItems } = await setup(page, baseURL);

    // 10 行の本文を入力（\n を Enter として一行ずつ）
    for (let i = 1; i <= 10; i++) {
      if (i > 1) await page.keyboard.press('Enter');
      await page.keyboard.type(`行${i}`);
    }

    // ガターアイテム数が 10 であること
    await expect(gutterItems).toHaveCount(10);

    // スクロール後もガターアイテム数と <p> 数が一致すること
    await page.evaluate(() => {
      const area = document.querySelector('.main-area');
      if (area) area.scrollTop = area.scrollHeight;
    });
    const pmPCount = await editor.evaluate((el) => el.children.length);
    await expect(gutterItems).toHaveCount(pmPCount);
  });

  test('ケースB: 折り返しても行番号は 1 つのみ・高さが <p> に追従する', async ({
    page,
    baseURL,
  }) => {
    const { editor, gutterItems } = await setup(page, baseURL);

    // 200 文字の改行なし 1 行テキスト
    await page.keyboard.type('あ'.repeat(200));

    await expect(gutterItems).toHaveCount(1);

    // sync の rAF 適用が完了するまで待つ
    await page.waitForFunction(() => {
      const item = document.querySelector('.editor-write-shell .line-number-gutter .line-number');
      return item ? item.style.height !== '' : false;
    });
    const gutterHeight = await gutterItems
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    const pHeight = await editor.evaluate(
      (el) => el.children[0]?.getBoundingClientRect().height ?? 0,
    );
    expect(Math.abs(gutterHeight - pHeight)).toBeLessThanOrEqual(1);
  });

  test('ケースC: 空行を含む本文でガターがズレない', async ({ page, baseURL }) => {
    const { gutterItems } = await setup(page, baseURL);

    // 行1 / 空行 / 行3
    await page.keyboard.type('行1');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('行3');

    await expect(gutterItems).toHaveCount(3);

    // sync の rAF 適用が完了するまで待つ
    await page.waitForFunction(() => {
      const item = document.querySelector('.editor-write-shell .line-number-gutter .line-number');
      return item ? item.style.height !== '' : false;
    });

    // 各ガターアイテムの高さが対応する <p> の高さと一致すること
    const heights = await page.evaluate(() => {
      const shell = document.querySelectorAll('.editor-write-shell')[0];
      const items = [...shell.querySelectorAll('.line-number-gutter .line-number')];
      const nodes = [...shell.querySelector('.tiptap.ProseMirror').children];
      return items.map((item, i) => ({
        gutter: item.getBoundingClientRect().height,
        para: nodes[i]?.getBoundingClientRect().height ?? 0,
      }));
    });

    for (const { gutter, para } of heights) {
      expect(Math.abs(gutter - para)).toBeLessThanOrEqual(1);
    }
  });

  test('ケースD: <br>を含む段落で行番号がセグメント数分表示される', async ({ page, baseURL }) => {
    const { gutterItems } = await setup(page, baseURL);

    // 1つの <p> 内に Shift+Enter で2つの HardBreak → 3セグメント
    await page.keyboard.type('行1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('行2');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('行3');

    await expect(gutterItems).toHaveCount(3);

    // sync の rAF 適用が完了するまで待つ
    await page.waitForFunction(() => {
      const item = document.querySelector('.editor-write-shell .line-number-gutter .line-number');
      return item ? item.style.height !== '' : false;
    });

    // 各セグメント高さが BR 位置で計測した実高さと一致すること
    const heights = await page.evaluate(() => {
      const shell = document.querySelectorAll('.editor-write-shell')[0];
      const items = [...shell.querySelectorAll('.line-number-gutter .line-number')];
      const pm = shell.querySelector('.tiptap.ProseMirror');
      const p = pm.children[0];
      const brs = [...p.querySelectorAll('br:not(.ProseMirror-trailingBreak)')];
      const pTop = p.getBoundingClientRect().top;
      const pBottom = p.getBoundingClientRect().bottom;

      let prevY = pTop;
      const expected = [];
      for (const br of brs) {
        const brBottom = br.getBoundingClientRect().bottom;
        expected.push(brBottom - prevY);
        prevY = brBottom;
      }
      expected.push(pBottom - prevY);

      return items.map((item, i) => ({
        gutter: item.getBoundingClientRect().height,
        expected: expected[i] ?? 0,
      }));
    });

    for (const { gutter, expected } of heights) {
      expect(Math.abs(gutter - expected)).toBeLessThanOrEqual(2);
    }
  });

  test('ケースE: 連続HardBreakで行番号が欠落しない', async ({ page, baseURL }) => {
    const { gutterItems } = await setup(page, baseURL);

    // 1つの <p> 内で Shift+Enter を連続して空セグメントを作る
    await page.keyboard.type('行1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('行3');

    // 2つの BR → 3セグメント
    await expect(gutterItems).toHaveCount(3);
  });
});
