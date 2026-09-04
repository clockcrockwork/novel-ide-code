import { test, expect } from '../fixtures/app';

/** ファイルドロップダウンを開く */
async function openDropdown(page) {
  await page.locator('.fpbtn').click();
  await expect(page.getByRole('listbox', { name: 'ファイル一覧' })).toBeVisible({ timeout: 5000 });
}

/** ドロップダウン内のファイル行（`.fdi`）のうち指定名を含む行の削除ボタンをクリックし、ダイアログを返す */
async function clickDeleteOnFile(page, nameSubstring) {
  const dialogPromise = page.waitForEvent('dialog');
  // data-nodeid を持たない .fdi がファイル行（フォルダは data-nodeid を持つ）
  const rows = page.locator('.fdrop .fdi:not([data-nodeid])');
  // テキストで絞り込む
  const targetRow = rows.filter({ hasText: nameSubstring }).first();
  const btn = targetRow.locator('[title="削除"]');
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  btn.click(); // dialog が出るため await しない（WebKit互換）
  return dialogPromise;
}

test.describe('ファイル操作', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL);
    await expect(page.locator('.tiptap.ProseMirror').first()).toBeVisible({ timeout: 15000 });
  });

  test('新規ファイルを作成するとファイル一覧に追加される', async ({ page }) => {
    await openDropdown(page);
    await page.getByText('＋ 新規').click();

    // ドロップダウンが閉じ、新規ファイルが選択される
    await expect(page.locator('.fpname')).toContainText('新規ファイル', { timeout: 5000 });

    // 再度開いて一覧に「新規ファイル」が含まれることを確認
    await openDropdown(page);
    await expect(
      page.locator('.fdrop .fdi:not([data-nodeid])').filter({ hasText: '新規ファイル' }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test('ファイルをクリックすると切り替わる', async ({ page }) => {
    // 確実に2件以上になるよう新規ファイルを作成
    await openDropdown(page);
    await page.getByText('＋ 新規').click();
    await expect(page.locator('.fpname')).toContainText('新規ファイル', { timeout: 5000 });

    // 切り替え前のファイル名をヘッダーから取得
    const beforeName = ((await page.locator('.fpname').textContent()) || '').trim();

    // 現在と異なるファイルをクリックして切り替え
    await openDropdown(page);
    await page
      .locator('.fdrop .fdi:not([data-nodeid])')
      .filter({ hasNotText: beforeName })
      .first()
      .click();

    // ヘッダーのファイル名が切り替え前と異なる名前になる
    await expect(page.locator('.fpname')).not.toContainText(beforeName, { timeout: 5000 });
  });

  test('削除ダイアログをキャンセルするとファイルが残る', async ({ page }) => {
    // 削除可能な新規ファイルを作成（これが current file になる）
    await openDropdown(page);
    await page.getByText('＋ 新規').click();
    await expect(page.locator('.fpname')).toContainText('新規ファイル', { timeout: 5000 });

    // ドロップダウンを開いて削除ボタンを押しキャンセル
    await openDropdown(page);
    const dialog = await clickDeleteOnFile(page, '新規ファイル');
    await dialog.dismiss();

    // キャンセル後もファイルが残っている（ヘッダーに名前が表示されたまま）
    await expect(page.locator('.fpname')).toContainText('新規ファイル', { timeout: 5000 });
  });

  test('削除ダイアログをOKすると対象ファイルが消える', async ({ page }) => {
    // 削除対象の新規ファイルを作成してから別ファイルへ切り替え
    await openDropdown(page);
    await page.getByText('＋ 新規').click();
    await expect(page.locator('.fpname')).toContainText('新規ファイル', { timeout: 5000 });

    // 別ファイルへ切り替え
    await openDropdown(page);
    const rows = page.locator('.fdrop .fdi:not([data-nodeid])');
    const otherRow = rows.filter({ hasNotText: '新規ファイル' }).first();
    await otherRow.click();

    // ファイル数を記録（描画完了を待ってから count）
    await openDropdown(page);
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    // eslint-disable-next-line local/no-locator-count -- before/after 比較パターン、toHaveCount では代替不可
    const beforeCount = await rows.count();

    // 削除を実行
    const dialog = await clickDeleteOnFile(page, '新規ファイル');
    await dialog.accept();

    // ドロップダウンが閉じることを確認（onClose が呼ばれる）
    await expect(page.getByRole('listbox', { name: 'ファイル一覧' })).not.toBeAttached({
      timeout: 3000,
    });

    // 再度開いてファイル数が減っていることを確認
    await openDropdown(page);
    await expect(page.locator('.fdrop .fdi:not([data-nodeid])')).toHaveCount(beforeCount - 1, {
      timeout: 5000,
    });
  });
});
