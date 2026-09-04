import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSIST_KEY_MAP,
  LOCAL_STORAGE_KEYS,
  FILES_STORAGE_KEY,
  FOLDERS_STORAGE_KEY,
} from '../../src/stores/persistKeys.js';
import {
  normalizeFileMetadata,
  normalizeKindDefinition,
} from '../../src/lib/metadata/normalizeFileMetadata.js';

// INVARIANTS #14 / LOCAL-STORAGE-PROTECTION.md の受け入れ条件を機械的に担保するガードテスト。

// secret / credential を示唆する語。localStorage キー・フィールド名がこれに
// 一致したら secret 保存先になっている疑いがあるため fail させる。
const SECRET_PATTERN =
  /token|secret|api[_-]?key|password|passwd|webhook|credential|priv(?:ate)?[_-]?key|bearer|session/i;

describe('localStorage に secret を保存しない（#14）', () => {
  it('localStorage キーカタログに secret 系の語を含むキーがない', () => {
    for (const key of LOCAL_STORAGE_KEYS) {
      assert.ok(
        !SECRET_PATTERN.test(key),
        `localStorage キー "${key}" が secret 系の語に一致する。secret は localStorage に保存しない（INVARIANTS #14）`,
      );
    }
  });

  it('PERSIST_KEY_MAP のフィールド名に secret 系の語がない', () => {
    for (const field of Object.keys(PERSIST_KEY_MAP)) {
      assert.ok(
        !SECRET_PATTERN.test(field),
        `永続化フィールド "${field}" が secret 系の語に一致する`,
      );
    }
  });

  it('カタログは PERSIST_KEY_MAP / filesStore / foldersStore のキーを網羅する', () => {
    for (const lsKey of Object.values(PERSIST_KEY_MAP)) {
      assert.ok(LOCAL_STORAGE_KEYS.includes(lsKey), `${lsKey} がカタログに含まれていない`);
    }
    assert.ok(LOCAL_STORAGE_KEYS.includes(FILES_STORAGE_KEY));
    assert.ok(LOCAL_STORAGE_KEYS.includes(FOLDERS_STORAGE_KEY));
  });
});

describe('IndexedDB 値は利用前に再検証する（#9 / #14）', () => {
  const kindIdSet = new Set([10, 20]);
  const statusIdSet = new Set([10]);

  it('範囲外 kindId / statusId は安全なデフォルトにフォールバックする', () => {
    const result = normalizeFileMetadata(
      { kindId: 9999, statusId: 9999 },
      { kindIdSet, statusIdSet },
    );
    assert.equal(result.kindId, 20);
    assert.equal(result.statusId, 10);
  });

  it('不正な型の値を安全な形に正規化する', () => {
    const result = normalizeFileMetadata(
      { tagIds: 'not-an-array', createdAt: 'bad', isDirty: 'true', title: 123 },
      { kindIdSet, statusIdSet },
    );
    assert.deepEqual(result.tagIds, []);
    assert.equal(typeof result.createdAt, 'number');
    assert.ok(result.createdAt > 0);
    assert.equal(result.isDirty, false);
    assert.equal(result.title, '');
  });

  it('null / undefined 入力でも throw せずフォールバックを返す', () => {
    const resultNull = normalizeFileMetadata(null, { kindIdSet, statusIdSet });
    assert.equal(resultNull.kindId, 20);
    assert.equal(resultNull.statusId, 10);
    assert.deepEqual(resultNull.tagIds, []);

    const resultUndefined = normalizeFileMetadata(undefined);
    assert.equal(resultUndefined.kindId, 20);
    assert.equal(resultUndefined.statusId, 10);
    assert.deepEqual(resultUndefined.tagIds, []);
  });

  it('改ざんされた kindDefinition は null になる', () => {
    assert.equal(normalizeKindDefinition({ id: 'x', key: 'k' }), null);
    assert.equal(normalizeKindDefinition({ id: 1 }), null);
  });
});

describe('IDB 由来データでプロトタイプ汚染を起こさない（#11 / #14）', () => {
  it('custom の __proto__ ペイロードで Object.prototype を汚染しない', () => {
    const fieldDefs = [{ id: 'f1', key: 'f1', type: 'text' }];
    const raw = JSON.parse('{"custom":{"__proto__":{"polluted":true},"f1":"ok"}}');
    const result = normalizeFileMetadata(raw, {
      kindIdSet: new Set([20]),
      statusIdSet: new Set([10]),
      fieldDefs,
    });
    assert.equal({}.polluted, undefined, 'Object.prototype が汚染された');
    assert.equal(Object.getPrototypeOf(result.custom), null);
    assert.equal(result.custom.f1, 'ok');
  });
});

// 注: export 時に secret 相当を混ぜない allowlist（serializeFileMetadataForGit）の
// 検証は #148 の責務。本ファイルはローカル保存（localStorage / IDB）に閉じる。
