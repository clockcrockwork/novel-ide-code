import { describe, it, expect } from 'vitest';
import { buildBackup, validateBackupEnvelope } from './backup';
import { KNOWN_STORES, fullStores } from '../__tests__/backupRestoreKnownStores';

describe('buildBackup（#216 / #219 全データ JSON バックアップ）', () => {
  const now = new Date('2026-08-29T01:23:00.000Z');

  it('formatVersion / dbVersion / exportedAt / stores の形状を持つ', () => {
    const backup = buildBackup({ files: [] }, { now });
    // BACKUP_FORMAT_VERSION / DB_VERSION と同じ定数を突き合わせると値の回帰を
    // 検知できないため、リテラルで固定する（バージョンを上げる際にここで一度止まる）。
    expect(backup.formatVersion).toBe(1);
    expect(backup.dbVersion).toBe(4);
    expect(backup.exportedAt).toBe('2026-08-29T01:23:00.000Z');
    expect(backup.stores).toEqual({ files: [] });
  });

  it('meta から deviceId / ghUser / lastSyncedAt を除外する', () => {
    const backup = buildBackup(
      {
        meta: [
          { key: 'deviceId', value: 'device-1' },
          { key: 'ghUser', value: { login: 'octocat' } },
          { key: 'lastSyncedAt', value: 1234567890 },
          { key: 'fid', value: 'file-1' },
        ],
      },
      { now },
    );
    const keys = backup.stores.meta.map((r) => r.key);
    expect(keys).not.toContain('deviceId');
    expect(keys).not.toContain('ghUser');
    expect(keys).not.toContain('lastSyncedAt');
    expect(keys).toContain('fid');
  });

  it('migrated_from_ls / migrated_word_count_settings_v1 は除外せず残す', () => {
    const backup = buildBackup(
      {
        meta: [
          { key: 'migrated_from_ls', value: true },
          { key: 'migrated_word_count_settings_v1', value: true },
        ],
      },
      { now },
    );
    const keys = backup.stores.meta.map((r) => r.key);
    expect(keys).toContain('migrated_from_ls');
    expect(keys).toContain('migrated_word_count_settings_v1');
  });

  it('meta 以外のストアは素通しする（フィルタしない）', () => {
    const files = [{ id: 'f1', name: 'a.md', content: 'hello' }];
    const folders = [{ id: 'fo1', name: 'フォルダ' }];
    const backup = buildBackup({ files, folders }, { now });
    expect(backup.stores.files).toBe(files);
    expect(backup.stores.folders).toBe(folders);
  });
});

// 書き手（buildBackup）と読み手（validateBackupEnvelope）の形式の正本を同一ファイルに置く。
describe('validateBackupEnvelope（JSON バックアップ復元 #216 / #219）', () => {
  const opts = {
    knownStoreNames: new Set(KNOWN_STORES),
    currentFormatVersion: 1,
    currentDbVersion: 4,
  };

  it('正当なエンベロープは受理する', () => {
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: fullStores({ files: [{ id: 'f1' }] }) },
      opts,
    );
    expect(result).toEqual({ ok: true });
  });

  it('トップレベルが非 object（配列）なら拒否する', () => {
    const result = validateBackupEnvelope([1, 2, 3], opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });

  it('トップレベルが null なら拒否する', () => {
    const result = validateBackupEnvelope(null, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });

  it('formatVersion が未来値なら拒否する', () => {
    const result = validateBackupEnvelope({ formatVersion: 99, dbVersion: 4, stores: {} }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('future_format_version');
  });

  it('dbVersion が未来値なら拒否する', () => {
    const result = validateBackupEnvelope({ formatVersion: 1, dbVersion: 99, stores: {} }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('future_db_version');
  });

  it('formatVersion / dbVersion が現在と同一なら受理する', () => {
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: fullStores() },
      opts,
    );
    expect(result.ok).toBe(true);
  });

  it('formatVersion が現在より小さい正の値（過去値）なら受理する', () => {
    // 現時点の BACKUP_FORMAT_VERSION は 1 のため、過去値を作るには currentFormatVersion を
    // 上げてテストする（B5: 下限 1 を追加しただけで、過去値受理の非対称自体は維持）。
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: fullStores() },
      { ...opts, currentFormatVersion: 2 },
    );
    expect(result.ok).toBe(true);
  });

  // B5: formatVersion の 0 / 負値は「過去値の受理」対象ではなく不正形状として拒否する。
  it.each([0, -1])('formatVersion が %i の場合は invalid_shape で拒否する', (formatVersion) => {
    const result = validateBackupEnvelope(
      { formatVersion, dbVersion: 4, stores: fullStores() },
      opts,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });

  // A1: dbVersion は現在値か、明示的な migration がある過去値のみ受理する（fail-closed）。
  // formatVersion とは非対称（checkFormatVersion / checkDbVersion のコメント参照）。
  // dbVersion: 2 は migration が定義されていない過去値（#610 の migration は dbVersion: 3 のみ）。
  it('migration の無い過去 dbVersion は unsupported_db_version で拒否する', () => {
    const result = validateBackupEnvelope({ formatVersion: 1, dbVersion: 2, stores: {} }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_db_version');
    expect(result.message).toContain('2');
    expect(result.message).toContain('4');
  });

  // #610: dbVersion: 3 → 4（syncState 追加）は migration が定義されているため受理する。
  // syncState だけ欠けている（旧バックアップにまだ存在しなかった）状態でも missing_store
  // にならないことを確認する。
  it('dbVersion: 3（syncState 追加前）は syncState 欠落を許して受理する', () => {
    const { syncState: _syncState, ...storesWithoutSyncState } = fullStores();
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 3, stores: storesWithoutSyncState },
      opts,
    );
    expect(result).toEqual({ ok: true });
  });

  it('dbVersion: 3 でも syncState 以外の既知ストアが欠けていれば missing_store で拒否する', () => {
    const { syncState: _syncState, folders: _folders, ...stores } = fullStores();
    const result = validateBackupEnvelope({ formatVersion: 1, dbVersion: 3, stores }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing_store');
    expect(result.message).toContain('folders');
  });

  it('未知のストアキーが含まれる場合は拒否する', () => {
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: { unknownStore: [] } },
      opts,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_store');
    expect(result.message).toContain('unknownStore');
  });

  // A1: 既知ストアが1つでも欠けていると、そのストアが空で復元されて全消去になるため
  // fail-closed で拒否する（実証済みの失敗: stores: {} で全12ストアが clear される）。
  it('既知ストアが欠けている場合は missing_store で拒否する', () => {
    const { folders: _folders, ...storesWithoutFolders } = fullStores();
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: storesWithoutFolders },
      opts,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing_store');
    expect(result.message).toContain('folders');
  });

  it('__proto__ をストアキーに持つ場合も未知のストアとして拒否する', () => {
    const stores = JSON.parse('{"__proto__": [1,2,3]}');
    const result = validateBackupEnvelope({ formatVersion: 1, dbVersion: 4, stores }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_store');
    // JSON.parse で作られた __proto__ は own property であり Object.prototype は汚染されない
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('ストア値が配列でない場合は拒否する', () => {
    const result = validateBackupEnvelope(
      { formatVersion: 1, dbVersion: 4, stores: { files: { id: 'f1' } } },
      opts,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });

  it('formatVersion が数値でない場合は拒否する', () => {
    const result = validateBackupEnvelope({ formatVersion: '1', dbVersion: 4, stores: {} }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });

  it('stores が欠落している場合は拒否する', () => {
    const result = validateBackupEnvelope({ formatVersion: 1, dbVersion: 3 }, opts);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_shape');
  });
});
