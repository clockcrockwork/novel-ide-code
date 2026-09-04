import { test as base, expect, DB_NAME, DB_VERSION } from '../fixtures/app';
import { filesContainText } from '../helpers/idbFiles';

// GitHub 未接続時の退避モード（#245）。新規 IndexedDB には meta.ghUser が存在せず、
// これがそのまま未接続状態になる（追加フィクスチャは不要）。
// 現行の E2E 環境は `npm run preview`（Worker 非同居）のため、/auth/refresh を明示的に
// 401 で mock する。mock しないと「Worker が居ないから偶然失敗している」状態に依存した
// テストになり、環境が変わると意味を失う。
const test = base.extend({
  appPage: async ({ page, baseURL }, runFixture) => {
    await page.route('**/auth/refresh', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.goto(baseURL);
    await runFixture(page);
  },
});

test.describe('GitHub 未接続時の退避モード', () => {
  test('未接続でも本文の編集と IndexedDB への保存ができる', async ({ appPage: page }) => {
    const editor = page.locator('.tiptap.ProseMirror').first();
    await editor.click();

    const value = `退避モード永続化テスト-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await page.keyboard.type(value);

    await expect.poll(() => filesContainText(page, DB_NAME, DB_VERSION, value)).toBeTruthy();
  });

  test('ヘッダーに「ログイン」導線が出て、同期系UIは表示されない（ghUser ゲート）', async ({
    appPage: page,
  }) => {
    // 未接続時は「ログイン」導線が出る（接続後は @login 表示に変わる）
    await expect(page.locator('.ghbtn')).toContainText('ログイン');

    // SyncBadge・「今すぐ同期」ボタンは ghUser ゲートでレンダリングされない
    await expect(page.getByTitle('今すぐ同期')).not.toBeAttached();
    // SyncBadge が出しうるラベルの全量。新ラベルを足したらここにも足すこと
    // （正本: src/components/header/SyncBadge.jsx の ERROR_LABEL と docs/data-model/sync-contract.md §6）。
    for (const title of [
      'オフライン',
      '競合あり',
      '同期中',
      '同期失敗',
      '同期待ち',
      '再同期が必要',
      '再ログインが必要',
      '権限・制限エラー',
      '同期データエラー',
      '同期を中止',
      '同期データ破損',
      '時間をおいて再試行',
      '通信エラー',
      'サイズ超過',
      'アプリの更新が必要',
    ]) {
      await expect(page.getByTitle(title, { exact: false })).not.toBeAttached();
    }
  });

  test('エクスポート（全データバックアップ .json）に到達できる', async ({ appPage: page }) => {
    // エクスポートボタンは ghUser 非ゲート。未接続でも退避出力に到達できることが #218 の
    // 保証そのものであり、削除・移設せずここに残す（将来ゲートが付いたときの回帰検出用）。
    await page.getByTitle('エクスポート').click();
    const backupButton = page.getByRole('button', { name: /全データバックアップ/ });
    await expect(backupButton).toBeVisible();
    await expect(backupButton).toBeEnabled();

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await backupButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^novel-ide-backup-.*\.json$/);
  });

  test('未接続のままファイル名を変更してもログインモーダルが開かない', async ({
    appPage: page,
  }) => {
    // triggerSync が実際に叩く /sync/manifest も 401 を返す想定に揃える（A1 の再発防止）。
    await page.route('**/sync/manifest', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );

    await page.locator('.fpbtn').click();
    await expect(page.getByRole('listbox', { name: 'ファイル一覧' })).toBeVisible({
      timeout: 5000,
    });

    await page.locator('.fdrop .fdi:not([data-nodeid])').first().getByTitle('名前を変更').click();

    const input = page.locator('.modal input[type="text"]');
    await expect(input).toBeVisible();
    await input.fill(`リネームテスト-${Date.now()}`);
    // ファイル一覧の各行にも「名前を変更」ボタン（アクセシブルネームに「変更」を含む）があり
    // 部分一致だと複数ヒットするため、モーダル配下かつ完全一致で絞り込む
    await page.locator('.modal').getByRole('button', { name: '変更', exact: true }).click();

    // リネームモーダルは保存成功時のみ onClose される（NameInputModal）。
    // input が残っていれば保存失敗。
    await expect(input).not.toBeAttached({ timeout: 5000 });

    // triggerSync が /sync/manifest 401 を経ても、ログインモーダルは開かない。
    // .overlay は NameInputModal 自身も使う（表示中は .overlay が1件）ため判定に使えない。
    // GithubModal 固有の要素（ログインボタン）で判定する。
    await expect(page.getByRole('button', { name: 'GitHub でログイン' })).not.toBeAttached();
  });
});
