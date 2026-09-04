import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFolderRecord,
  normalizeFolderRecords,
} from '../../src/lib/normalizeFolderRecord.js';

// audit L1 / INVARIANTS #9: folders ストアの IDB 読み出し値を利用前に正規化する。
// files 側（normalizeFileRecord）と対称。

describe('normalizeFolderRecord — id 検証', () => {
  it('id が無い / 非文字列 / 空文字 / 非オブジェクトなら null', () => {
    assert.equal(normalizeFolderRecord({}), null);
    assert.equal(normalizeFolderRecord({ id: 123 }), null);
    assert.equal(normalizeFolderRecord({ id: '' }), null);
    assert.equal(normalizeFolderRecord(null), null);
    assert.equal(normalizeFolderRecord('not-object'), null);
    assert.equal(normalizeFolderRecord([]), null);
  });

  it('パストラバーサル・不正文字を含む id は null', () => {
    assert.equal(normalizeFolderRecord({ id: '../secret' }), null);
    assert.equal(normalizeFolderRecord({ id: 'a/b' }), null);
    assert.equal(normalizeFolderRecord({ id: '..' }), null);
    assert.equal(normalizeFolderRecord({ id: 'a'.repeat(129) }), null);
  });

  it('正規の id 形式（UUID / 数字 / base36 フォールバック）は通す', () => {
    assert.ok(normalizeFolderRecord({ id: '550e8400-e29b-41d4-a716-446655440000' }));
    assert.ok(normalizeFolderRecord({ id: '1' }));
    assert.ok(normalizeFolderRecord({ id: '1718900000000-ab12cd' }));
  });
});

describe('normalizeFolderRecord — 型フォールバック', () => {
  it('不正な型を安全なデフォルトに正規化する', () => {
    const r = normalizeFolderRecord({
      id: 'a',
      name: 123,
      parentId: {},
      sortOrder: 'bad',
      createdAt: 'bad',
    });
    assert.equal(r.id, 'a');
    assert.equal(r.name, 'フォルダ'); // 非文字列名はデフォルトへ
    assert.equal(r.parentId, null); // 非文字列 parentId は null
    assert.equal(r.sortOrder, 0); // 非数値 sortOrder は 0
    assert.equal(typeof r.createdAt, 'number');
    assert.ok(r.createdAt > 0);
  });

  it('自己参照 parentId は null に倒す（循環要因の排除）', () => {
    const r = normalizeFolderRecord({ id: 'self', parentId: 'self' });
    assert.equal(r.parentId, null);
  });

  it('パストラバーサル風 parentId は null に倒す', () => {
    const r = normalizeFolderRecord({ id: 'a', parentId: '../x' });
    assert.equal(r.parentId, null);
  });

  it('正規のレコードは値を保持する', () => {
    const raw = {
      id: 'f1',
      name: '第一部',
      parentId: 'root-folder',
      sortOrder: 3,
      createdAt: 1718900000000,
    };
    const r = normalizeFolderRecord(raw);
    assert.equal(r.id, 'f1');
    assert.equal(r.name, '第一部');
    assert.equal(r.parentId, 'root-folder');
    assert.equal(r.sortOrder, 3);
    assert.equal(r.createdAt, 1718900000000);
  });

  it('allowlist 外プロパティ（改ざん注入）を落とす', () => {
    const r = normalizeFolderRecord({
      id: 'a',
      name: 'x',
      evil: 'DROP',
      __proto__: { polluted: true },
    });
    assert.equal(Object.hasOwn(r, 'evil'), false);
    assert.deepEqual(Object.keys(r).sort(), ['createdAt', 'id', 'name', 'parentId', 'sortOrder']);
  });
});

describe('normalizeFolderRecords — 配列', () => {
  it('非配列は空配列', () => {
    assert.deepEqual(normalizeFolderRecords(null), []);
    assert.deepEqual(normalizeFolderRecords({}), []);
  });

  it('不正レコードを除外し、正規レコードのみ残す', () => {
    const rows = [
      { id: 'ok1', name: 'A' },
      { id: 123 }, // 不正 id → 除外
      { id: 'ok2', name: 'B' },
      null, // 除外
      'x', // 除外
    ];
    const out = normalizeFolderRecords(rows);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((f) => f.id),
      ['ok1', 'ok2'],
    );
  });
});
