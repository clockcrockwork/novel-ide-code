import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbRestoreAllStoresMock = vi.fn();
const getDbMock = vi.fn();

vi.mock('./db', async (importOriginal) => {
  // DEFAULT_KIND_DEFINITIONS / DEFAULT_STATUS_DEFINITIONS は db.js の実値を複製せず使う。
  // getDb / dbRestoreAllStores のみ差し替える。
  const actual = await importOriginal();
  return {
    getDb: (...args) => getDbMock(...args),
    dbRestoreAllStores: (...args) => dbRestoreAllStoresMock(...args),
    DB_VERSION: 3,
    DEFAULT_KIND_DEFINITIONS: actual.DEFAULT_KIND_DEFINITIONS,
    DEFAULT_STATUS_DEFINITIONS: actual.DEFAULT_STATUS_DEFINITIONS,
  };
});

import { restoreFromBackup } from './restore';
import { DEFAULT_KIND_DEFINITIONS, DEFAULT_STATUS_DEFINITIONS } from './db';
import { KNOWN_STORES, fullStores } from '../__tests__/backupRestoreKnownStores';

function makeBackup(storesOverride = {}) {
  return {
    formatVersion: 1,
    dbVersion: 3,
    exportedAt: '2026-08-29T00:00:00.000Z',
    stores: fullStores(storesOverride),
  };
}

describe('restoreFromBackup（JSON バックアップ復元 #216 / #219）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockResolvedValue({ objectStoreNames: KNOWN_STORES });
    dbRestoreAllStoresMock.mockResolvedValue(undefined);
  });

  it('JSON 構文エラーは parse_error を返し書き込みを一切行わない', async () => {
    const result = await restoreFromBackup('{ invalid json');
    expect(result).toEqual({
      ok: false,
      code: 'parse_error',
      message: expect.any(String),
    });
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  // B4: エンベロープ検証の分岐網羅（未来 formatVersion / 未来 dbVersion / 未知ストアキー / 過去
  // dbVersion 等）は backup.test.js の validateBackupEnvelope テストが持つ。ここでは
  // restoreFromBackup 経由でしか確認できない「早期 return の配線」（envelope 検証失敗時に
  // dbRestoreAllStoresMock を呼ばない）だけを、代表1ケース（missing_store）で固定する。
  it('既知ストアが欠けている場合は missing_store で拒否する（配線確認）', async () => {
    const { folders: _folders, ...storesWithoutFolders } = fullStores();
    const backup = {
      formatVersion: 1,
      dbVersion: 3,
      exportedAt: '2026-08-29T00:00:00.000Z',
      stores: storesWithoutFolders,
    };
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing_store');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  // A1: settings/meta/workspaceSettings[].value の個別上限は findOversizedKeyedValue
  // （restore.js）を正本とする。
  it('settings[].value が上限超過なら oversized で拒否する', async () => {
    const backup = makeBackup({
      settings: [{ key: 'bigSetting', value: 'x'.repeat(5_000_001) }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('oversized');
    expect(result.message).toContain('settings');
    expect(result.message).toContain('bigSetting');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  // A1 回帰防止: BACKUP_TEXT_MAX（全体サイズ上限）の撤去後も、各 files[].content が
  // FILE_CONTENT_MAX 以内であれば合計サイズに関わらず受理されることを固定する
  // （5000 ファイル × 2万文字＝実測 100,493,068 文字の正規バックアップが oversized で
  // 拒否されていた退行の再発防止）。
  it('files の合計文字数が大きくても各 files[].content が上限内なら受理される', async () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({
      id: `f${i}`,
      name: `file-${i}.md`,
      content: 'x'.repeat(20000),
    }));
    const backup = makeBackup({ files });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result).toEqual({ ok: true });
  }, 20000);

  it('files[].content が上限超過ならファイル名を含めて失敗し、書き込みを行わない', async () => {
    const backup = makeBackup({
      files: [{ id: 'f1', name: '巨大ファイル.md', content: 'x'.repeat(5_000_001) }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('oversized');
    expect(result.message).toContain('巨大ファイル.md');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  it('name が無い oversized ファイルは id をメッセージに含める', async () => {
    const backup = makeBackup({
      files: [{ id: 'valid-id', content: 'x'.repeat(5_000_001) }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('valid-id');
  });

  it('FILE_ID_RE 不適合な files[].id（パストラバーサル）は除外される', async () => {
    const backup = makeBackup({
      files: [
        { id: '../manifest', name: 'a.md', content: 'ok' },
        { id: 'valid-id', name: 'b.md', content: 'ok' },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('files').map((f) => f.id)).toEqual(['valid-id']);
  });

  // A5: raw が1件以上あるのに正規化後0件（全件 drop）なら fail-closed にする（理由は restore.js
  // 側のコメントを正本とする）。
  it('files が全件不正な形式で正規化後0件なら no_valid_records で拒否し、書き込みを行わない', async () => {
    const backup = makeBackup({
      files: [{ id: '../manifest', name: 'a.md', content: 'ok' }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no_valid_records');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  it('folders が全件不正な形式で正規化後0件なら no_valid_records で拒否し、書き込みを行わない', async () => {
    const backup = makeBackup({
      folders: [{ id: '../evil-folder' }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no_valid_records');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  it('files / folders が空配列（0件）の場合は no_valid_records にならない', async () => {
    const backup = makeBackup({});
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result).toEqual({ ok: true });
  });

  it('githubRepoPath が不正な workSettings はフィールド単位で drop する', async () => {
    const backup = makeBackup({
      workSettings: [
        { id: 'w1', label: '作品1', githubRepoPath: '../secret' },
        { id: 'w2', label: '作品2', githubRepoPath: '/absolute' },
        { id: 'w3', label: '作品3', githubRepoPath: 'path?query' },
        { id: 'w4', label: '作品4', githubRepoPath: 'works/novel-a' },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    const byId = new Map(recordsByStore.get('workSettings').map((w) => [w.id, w]));
    expect(byId.get('w1').githubRepoPath).toBeUndefined();
    expect(byId.get('w2').githubRepoPath).toBeUndefined();
    expect(byId.get('w3').githubRepoPath).toBeUndefined();
    expect(byId.get('w4').githubRepoPath).toBe('works/novel-a');
  });

  // A2: 辞書空補完の理由は restore.js の resolveDictionaryDefinitions コメントを正本とする。
  it('kindDefinitions / statusDefinitions が空配列のバックアップを復元すると既定辞書が入る', async () => {
    const backup = makeBackup({ kindDefinitions: [], statusDefinitions: [] });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('kindDefinitions')).toEqual(DEFAULT_KIND_DEFINITIONS);
    expect(recordsByStore.get('statusDefinitions')).toEqual(DEFAULT_STATUS_DEFINITIONS);
  });

  it('kindDefinitions / statusDefinitions が1件以上あれば既定辞書で上書きしない', async () => {
    const backup = makeBackup({
      kindDefinitions: [{ id: 99, key: 'custom', label: 'カスタム' }],
      statusDefinitions: [{ id: 99, key: 'custom-status', label: 'カスタム状態' }],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('kindDefinitions').map((d) => d.id)).toEqual([99]);
    expect(recordsByStore.get('statusDefinitions').map((d) => d.id)).toEqual([99]);
  });

  // A2: 空判定（rawList.length === 0）を回避しつつ既定辞書へすり替わるのを防ぐ回帰テスト。
  it('kindDefinitions が1件以上あるが全件不正な形式なら no_valid_records で拒否する', async () => {
    const backup = makeBackup({
      kindDefinitions: [{ id: 'not-a-number', key: 'custom', label: 'カスタム' }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no_valid_records');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  it('statusDefinitions が1件以上あるが全件不正な形式なら no_valid_records で拒否する', async () => {
    const backup = makeBackup({
      statusDefinitions: [{ id: 'not-a-number', key: 'custom-status', label: 'カスタム状態' }],
    });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no_valid_records');
    expect(dbRestoreAllStoresMock).not.toHaveBeenCalled();
  });

  // B8: 保証の理由は db.js（dbRestoreAllStores）のコメントを正本とする。
  it('meta の incoming は除外3キーを含んでいてもそのまま渡す（フィルタは db.js 側の責務）', async () => {
    const backup = makeBackup({
      meta: [
        { key: 'deviceId', value: 'backup-device' },
        { key: 'ghUser', value: { login: 'backup-user' } },
        { key: 'lastSyncedAt', value: 1 },
        { key: 'fid', value: 'file-1' },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    const metaKeys = recordsByStore
      .get('meta')
      .map((r) => r.key)
      .sort();
    expect(metaKeys).toEqual(['deviceId', 'fid', 'ghUser', 'lastSyncedAt']);
  });

  it('dbRestoreAllStores には meta の除外3キーを保持する preserveKeys が渡される', async () => {
    const backup = makeBackup({});
    await restoreFromBackup(JSON.stringify(backup));
    const restoreOptions = dbRestoreAllStoresMock.mock.calls[0][1];
    expect(restoreOptions.preserveKeys.get('meta')).toEqual(
      new Set(['deviceId', 'ghUser', 'lastSyncedAt']),
    );
  });

  it('dangling parentId を持つ file は parentId=null に倒される', async () => {
    const backup = makeBackup({
      files: [{ id: 'f1', name: 'a.md', content: '', parentId: 'missing-folder' }],
      folders: [{ id: 'd1', name: 'D', parentId: null }],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('files')[0].parentId).toBeNull();
  });

  it('__proto__ をキーに持つ custom メタデータでも Object.prototype を汚染しない', async () => {
    const customFieldDefs = [{ id: 'cf1', key: 'note', label: 'メモ', type: 'text' }];
    const custom = JSON.parse('{"__proto__": "polluted", "cf1": "hello"}');
    const backup = makeBackup({
      customFieldDefs,
      fileMetadata: [{ fileId: 'f1', custom }],
    });
    await restoreFromBackup(JSON.stringify(backup));
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it('constructor / prototype をキーに持つ custom メタデータでも Object.prototype を汚染しない', async () => {
    const customFieldDefs = [{ id: 'cf1', key: 'note', label: 'メモ', type: 'text' }];
    const custom = JSON.parse(
      '{"constructor": {"prototype": {"polluted2": true}}, "prototype": {"polluted3": true}, "cf1": "hello"}',
    );
    const backup = makeBackup({
      customFieldDefs,
      fileMetadata: [{ fileId: 'f1', custom }],
    });
    await restoreFromBackup(JSON.stringify(backup));
    expect({}.polluted2).toBeUndefined();
    expect({}.polluted3).toBeUndefined();
    expect(Object.prototype.polluted2).toBeUndefined();
    expect(Object.prototype.polluted3).toBeUndefined();
  });

  it('書き込み失敗時は tx_failed を返す（部分適用を成功として報告しない）', async () => {
    dbRestoreAllStoresMock.mockRejectedValue(new Error('quota exceeded (simulated)'));
    const backup = makeBackup({ files: [{ id: 'f1', name: 'a.md', content: 'x' }] });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tx_failed');
  });

  it('正常系は ok:true を返す', async () => {
    const backup = makeBackup({ files: [{ id: 'f1', name: 'a.md', content: 'x' }] });
    const result = await restoreFromBackup(JSON.stringify(backup));
    expect(result).toEqual({ ok: true });
  });

  it('全ストアの clear + put が単一の dbRestoreAllStores 呼び出しで行われる（分割書き込みしない）', async () => {
    const backup = makeBackup({ files: [{ id: 'f1', name: 'a.md', content: 'x' }] });
    await restoreFromBackup(JSON.stringify(backup));
    expect(dbRestoreAllStoresMock).toHaveBeenCalledTimes(1);
  });

  // A4: customFieldDefs は setCustomFieldDefs（fileMetadataStore.js）の書き込み経路と同じ
  // 受理条件（id が文字列・label が文字列）に揃える。既定値（workId: '' / order: 999）を
  // 注入せず、素通しする。
  it('customFieldDefs は書き込み経路と同じ形に正規化され、既定値を注入しない', async () => {
    const backup = makeBackup({
      customFieldDefs: [
        { id: 'cf1', key: 'note', label: 'メモ', type: 'text' },
        { id: 'cf2', key: 'priority', label: '優先度', type: 'number', order: 5 },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    const byId = new Map(recordsByStore.get('customFieldDefs').map((d) => [d.id, d]));

    expect(byId.get('cf1').workId).toBeUndefined();
    expect(byId.get('cf1').order).toBeUndefined();
    expect(byId.get('cf1').archived).toBe(false);
    expect(byId.get('cf2').order).toBe(5);
  });

  // A4(b): 書き込み経路（setCustomFieldDefs）は id/label しか見ないため、key/type を持たない
  // 定義もアプリ自身が受理・保存しうる。復元がそれを弾くと往復で消える非可逆が生まれる。
  it('key / type を持たない customFieldDefs（書き込み経路が受理する形）も復元後に残る', async () => {
    const minimalId = 'cf-minimal';
    const backup = makeBackup({
      customFieldDefs: [{ id: minimalId, label: '最小定義' }],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    const byId = new Map(recordsByStore.get('customFieldDefs').map((d) => [d.id, d]));
    expect(byId.get(minimalId)).toBeDefined();
    expect(byId.get(minimalId).key).toBeUndefined();
    expect(byId.get(minimalId).type).toBeUndefined();
  });

  // A4(c): allowlist 抽出のため、__proto__ や未知プロパティは own プロパティとしてすら
  // 結果に含まれない（{ ...raw } が __proto__ を残してしまう問題自体が発生しない）。
  it('customFieldDefs の __proto__ や未知プロパティは結果に含まれない', async () => {
    const raw = JSON.parse(
      '{"id": "cf-untrusted", "label": "ラベル", "__proto__": "polluted", "unknownProp": "x"}',
    );
    const backup = makeBackup({ customFieldDefs: [raw] });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    const def = recordsByStore.get('customFieldDefs').find((d) => d.id === 'cf-untrusted');
    expect(def).toBeDefined();
    expect(Object.hasOwn(def, 'unknownProp')).toBe(false);
    expect(Object.getPrototypeOf(def)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
  });

  it('customFieldDefs の id が128文字を超える場合は除外する', async () => {
    const backup = makeBackup({
      customFieldDefs: [
        { id: 'x'.repeat(129), key: 'note', label: 'メモ', type: 'text' },
        { id: 'cf-ok', key: 'note2', label: 'メモ2', type: 'text' },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('customFieldDefs').map((d) => d.id)).toEqual(['cf-ok']);
  });

  it('customFieldDefs の label が1000文字を超える場合は除外する', async () => {
    const backup = makeBackup({
      customFieldDefs: [
        { id: 'cf-long-label', label: 'x'.repeat(1001) },
        { id: 'cf-ok', label: 'メモ' },
      ],
    });
    await restoreFromBackup(JSON.stringify(backup));
    const recordsByStore = dbRestoreAllStoresMock.mock.calls[0][0];
    expect(recordsByStore.get('customFieldDefs').map((d) => d.id)).toEqual(['cf-ok']);
  });
});
