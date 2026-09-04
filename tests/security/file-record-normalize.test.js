import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFileRecord, normalizeFileRecords } from '../../src/lib/normalizeFileRecord.js';

// INVARIANTS #9 / #14: files ストアの IDB 読み出し値を利用前に正規化する（#282）。

describe('normalizeFileRecord — id 検証', () => {
  it('id が無い / 非文字列 / 空文字なら null', () => {
    assert.equal(normalizeFileRecord({}), null);
    assert.equal(normalizeFileRecord({ id: 123 }), null);
    assert.equal(normalizeFileRecord({ id: '' }), null);
    assert.equal(normalizeFileRecord(null), null);
    assert.equal(normalizeFileRecord('not-object'), null);
  });

  it('パストラバーサル・不正文字を含む id は null（/sync/file URL の汚染防止）', () => {
    assert.equal(normalizeFileRecord({ id: '../manifest' }), null);
    assert.equal(normalizeFileRecord({ id: 'a/b' }), null);
    assert.equal(normalizeFileRecord({ id: '.' }), null);
    assert.equal(normalizeFileRecord({ id: 'a'.repeat(129) }), null);
  });

  it('正規の id 形式（UUID / 数字 / base36 フォールバック）は通す', () => {
    assert.ok(normalizeFileRecord({ id: '550e8400-e29b-41d4-a716-446655440000' }));
    assert.ok(normalizeFileRecord({ id: '1' }));
    assert.ok(normalizeFileRecord({ id: '1718900000000-ab12cd' }));
  });
});

describe('normalizeFileRecord — 型フォールバック', () => {
  it('不正な型を安全なデフォルトに正規化する', () => {
    const r = normalizeFileRecord({
      id: 'a',
      name: 123,
      content: 456,
      github: [],
      createdAt: 'bad',
      updatedAt: 0,
      isDirty: 'true',
    });
    assert.equal(r.id, 'a');
    assert.equal(r.name, 'ファイル.md');
    assert.equal(r.content, '');
    assert.equal(r.github, null);
    assert.equal(typeof r.createdAt, 'number');
    assert.ok(r.createdAt > 0);
    assert.equal(r.updatedAt, 0); // 不明な updatedAt は保守的に 0
    assert.equal(r.isDirty, false);
  });

  it('正常な値はそのまま保持する', () => {
    const r = normalizeFileRecord({
      id: 'a',
      name: 'clean.md',
      content: 'hello',
      parentId: 'folder-1',
      createdAt: 1000,
      updatedAt: 2000,
      isDirty: true,
    });
    assert.equal(r.name, 'clean.md');
    assert.equal(r.content, 'hello');
    assert.equal(r.parentId, 'folder-1');
    assert.equal(r.createdAt, 1000);
    assert.equal(r.updatedAt, 2000);
    assert.equal(r.isDirty, true);
  });

  it('parentId は FILE_ID_RE 適合かつ自己参照でない文字列のみ保持（フォルダ階層の維持）', () => {
    assert.equal(normalizeFileRecord({ id: 'a', parentId: 'f1' }).parentId, 'f1');
    assert.equal(normalizeFileRecord({ id: 'a' }).parentId, null);
    assert.equal(normalizeFileRecord({ id: 'a', parentId: 123 }).parentId, null);
    assert.equal(normalizeFileRecord({ id: 'a', parentId: '../evil' }).parentId, null);
    // 自己参照は fileTree の再帰ループ要因になるため null
    assert.equal(normalizeFileRecord({ id: 'a', parentId: 'a' }).parentId, null);
  });

  it('createdAt 不明時は now、updatedAt 不明時は 0（sync 保守的フォールバック）', () => {
    const r = normalizeFileRecord({ id: 'a' }, 5000);
    assert.equal(r.createdAt, 5000);
    assert.equal(r.updatedAt, 0);
  });

  it('updatedAt が 0 / 欠落なら 0 のまま（local が remote より新しいと誤判定させない）', () => {
    assert.equal(normalizeFileRecord({ id: 'a', updatedAt: 0 }).updatedAt, 0);
    assert.equal(normalizeFileRecord({ id: 'a', updatedAt: 'bad' }).updatedAt, 0);
    assert.equal(normalizeFileRecord({ id: 'a', updatedAt: 1700 }).updatedAt, 1700);
  });

  it('ファイル名の危険文字をサニタイズする', () => {
    const r = normalizeFileRecord({ id: 'a', name: 'foo/bar\x00.md' });
    assert.ok(!r.name.includes('/'));
    assert.ok(!r.name.includes('\x00'));
  });
});

describe('normalizeFileRecord — プロトタイプチェーン経由の値を読まない (#312 / INVARIANTS #11)', () => {
  it('継承プロパティは無視し own プロパティのみ採用する', () => {
    const proto = {
      name: 'EVIL.md',
      content: 'EVIL',
      parentId: 'EVIL',
      isDirty: true,
      github: { owner: 'evil' },
    };
    const polluted = Object.create(proto);
    polluted.id = 'a';
    const r = normalizeFileRecord(polluted);
    assert.equal(r.name, 'ファイル.md');
    assert.equal(r.content, '');
    assert.equal(r.parentId, null);
    assert.equal(r.isDirty, false);
    assert.equal(r.github, null);
  });

  it('各プロパティを1度だけ読み出す（getter による TOCTOU バイパス防止）', () => {
    let idReads = 0;
    let contentReads = 0;
    const raw = {};
    Object.defineProperty(raw, 'id', {
      enumerable: true,
      get() {
        idReads += 1;
        return idReads === 1 ? 'safe' : '../evil';
      },
    });
    Object.defineProperty(raw, 'content', {
      enumerable: true,
      get() {
        contentReads += 1;
        return contentReads === 1 ? 'first' : 'MUTATED';
      },
    });
    const r = normalizeFileRecord(raw);
    // 検証と採用で同じ値（最初の読み取り）が使われる
    assert.equal(r.id, 'safe');
    assert.equal(r.content, 'first');
    assert.equal(idReads, 1);
    assert.equal(contentReads, 1);
  });

  it('github / security も継承プロパティを読まない', () => {
    const ghProto = { owner: 'evil', repo: 'evil' };
    const gh = Object.create(ghProto);
    gh.path = 'real.md';
    const r = normalizeFileRecord({ id: 'a', github: gh, security: Object.create({ decision: 'deny' }) });
    assert.deepEqual(r.github, { path: 'real.md' });
    assert.equal(r.security.decision, 'allow');
  });
});

describe('normalizeFileRecord — github 参照の allowlist', () => {
  it('既知フィールドのみ抽出し不要・危険プロパティを落とす', () => {
    const raw = JSON.parse(
      '{"id":"a","github":{"owner":"o","repo":"r","path":"p.md","sha":"s","branch":"main","__proto__":{"polluted":true},"evil":"x"}}',
    );
    const r = normalizeFileRecord(raw);
    assert.deepEqual(r.github, { owner: 'o', repo: 'r', path: 'p.md', sha: 's', branch: 'main' });
    assert.equal('evil' in r.github, false);
    assert.equal({}.polluted, undefined);
  });

  it('非文字列フィールドは除外する', () => {
    const r = normalizeFileRecord({ id: 'a', github: { owner: 'o', repo: 123 } });
    assert.deepEqual(r.github, { owner: 'o' });
  });

  it('github が無い / 配列 / 有効フィールドゼロなら null', () => {
    assert.equal(normalizeFileRecord({ id: 'a' }).github, null);
    assert.equal(normalizeFileRecord({ id: 'a', github: ['x'] }).github, null);
    assert.equal(normalizeFileRecord({ id: 'a', github: {} }).github, null);
    assert.equal(normalizeFileRecord({ id: 'a', github: { evil: 'x' } }).github, null);
  });
});

describe('normalizeFileRecord — security レコード', () => {
  it('security 無しの legacy レコードは security を持たない（quarantine されない）', () => {
    const r = normalizeFileRecord({ id: 'a', name: 'a.md', content: 'x' });
    assert.equal('security' in r, false);
  });

  it('decision が範囲外なら allow にフォールバックする', () => {
    const r = normalizeFileRecord({ id: 'a', security: { decision: 'evil' } });
    assert.equal(r.security.decision, 'allow');
  });

  it('deny は保持し quarantine 判定を維持する', () => {
    const r = normalizeFileRecord({ id: 'a', security: { decision: 'deny' } });
    assert.equal(r.security.decision, 'deny');
  });

  it('security の boolean フィールドを型強制する', () => {
    const r = normalizeFileRecord({
      id: 'a',
      security: { decision: 'warn', isBinary: 'yes', hasDeny: 1, denyReason: 42 },
    });
    assert.equal(r.security.isBinary, false);
    assert.equal(r.security.hasDeny, false);
    assert.equal(r.security.denyReason, null);
  });

  it('security が配列なら無視する', () => {
    const r = normalizeFileRecord({ id: 'a', security: ['deny'] });
    assert.equal('security' in r, false);
  });
});

describe('normalizeFileRecords — 配列', () => {
  it('不正レコード（null）を除外する', () => {
    const rows = normalizeFileRecords([
      { id: 'a', name: 'a.md' },
      { id: 123 },
      null,
      { id: 'b', name: 'b.md' },
    ]);
    assert.deepEqual(
      rows.map((r) => r.id),
      ['a', 'b'],
    );
  });

  it('配列でなければ空配列を返す', () => {
    assert.deepEqual(normalizeFileRecords(null), []);
    assert.deepEqual(normalizeFileRecords(undefined), []);
    assert.deepEqual(normalizeFileRecords('x'), []);
  });
});
