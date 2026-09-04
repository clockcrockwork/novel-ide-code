import { describe, it, expect } from 'vitest';
import {
  mergeStructure,
  parseRemoteStructure,
  readBaseStructure,
  normalizeRemoteFolders,
  foldersArrayToDict,
  foldersDictToArray,
  STRUCTURE_BASE_KEY,
} from './structure';

// pr394-c1-risk.md の想定ケース表（B1–B12・D1・D6・F1–F6・K2）に対応する組合せテスト。
// mergeStructure は純関数なので、base/local/remote を明示的に組み立てて検証する。

const UNKNOWN = { known: false, folders: Object.create(null), fileParentIds: Object.create(null) };
function known(folders = {}, fileParentIds = {}, malformedFolderIds = new Set()) {
  return { known: true, folders: Object.assign(Object.create(null), folders), malformedFolderIds, fileParentIds: Object.assign(Object.create(null), fileParentIds) };
}
function folder(id, over = {}) {
  return { id, name: 'F', parentId: null, sortOrder: 0, createdAt: 1000, ...over };
}

describe('mergeStructure — A/B: folder の 3-way 組合せ', () => {
  it('B1: local のみ作成 → 新規保持（push 方向）', () => {
    const result = mergeStructure({
      base: known(),
      local: { folders: { a: folder('a') }, fileParentIds: {} },
      remote: known(),
      localFileIds: new Set(),
    });
    expect(result.folders.a).toEqual(folder('a'));
    expect(result.deletedFolderIds.size).toBe(0);
  });

  it('B2: remote のみ作成 → 新規保持（pull 方向）', () => {
    const result = mergeStructure({
      base: known(),
      local: { folders: {}, fileParentIds: {} },
      remote: known({ a: folder('a') }),
      localFileIds: new Set(),
    });
    expect(result.folders.a).toEqual(folder('a'));
  });

  it('B3: 両側で別 folder を作成 → union', () => {
    const result = mergeStructure({
      base: known(),
      local: { folders: { a: folder('a') }, fileParentIds: {} },
      remote: known({ b: folder('b') }),
      localFileIds: new Set(),
    });
    expect(Object.keys(result.folders).sort()).toEqual(['a', 'b']);
  });

  it('B4: 同一 folder の同一フィールドが両側で乖離 → remote 優先', () => {
    const base = known({ a: folder('a', { name: '元' }) });
    const result = mergeStructure({
      base,
      local: { folders: { a: folder('a', { name: 'local改名' }) }, fileParentIds: {} },
      remote: known({ a: folder('a', { name: 'remote改名' }) }),
      localFileIds: new Set(),
    });
    expect(result.folders.a.name).toBe('remote改名');
  });

  it('B5: 別フィールドが片側ずつ変化 → フィールド単位で変化側を採用', () => {
    const base = known({ a: folder('a', { name: '元', sortOrder: 0 }) });
    const result = mergeStructure({
      base,
      local: { folders: { a: folder('a', { name: '元', sortOrder: 5 }) }, fileParentIds: {} },
      remote: known({ a: folder('a', { name: 'remote改名', sortOrder: 0 }) }),
      localFileIds: new Set(),
    });
    expect(result.folders.a.name).toBe('remote改名');
    expect(result.folders.a.sortOrder).toBe(5);
  });

  it('B6a: local が削除 × remote が rename → 削除が勝つ', () => {
    const base = known({ a: folder('a', { name: '元' }) });
    const result = mergeStructure({
      base,
      local: { folders: {}, fileParentIds: {} },
      remote: known({ a: folder('a', { name: 'remote改名' }) }),
      localFileIds: new Set(),
    });
    expect(result.folders.a).toBeUndefined();
    expect(result.deletedFolderIds.has('a')).toBe(true);
  });

  it('B6b: remote が削除 × local が rename → 削除が勝つ', () => {
    const base = known({ a: folder('a', { name: '元' }) });
    const result = mergeStructure({
      base,
      local: { folders: { a: folder('a', { name: 'local改名' }) }, fileParentIds: {} },
      remote: known({}),
      localFileIds: new Set(),
    });
    expect(result.folders.a).toBeUndefined();
    expect(result.deletedFolderIds.has('a')).toBe(true);
  });

  it('B7: 古い base の端末が復帰、相手が新規追加 → remote 新規は保持（削除と誤判定しない）', () => {
    const base = known({}); // この端末の base はまだ b を知らない
    const result = mergeStructure({
      base,
      local: { folders: {}, fileParentIds: {} },
      remote: known({ b: folder('b') }),
      localFileIds: new Set(),
    });
    expect(result.folders.b).toEqual(folder('b'));
    expect(result.deletedFolderIds.size).toBe(0);
  });

  it('B8: file の parentId が両側で別 folder へ → フィールド単位 3-way、乖離は remote 優先', () => {
    const base = { known: true, folders: Object.create(null), fileParentIds: { f1: 'x' } };
    const result = mergeStructure({
      base,
      local: { folders: {}, fileParentIds: { f1: 'local-folder' } },
      remote: known({}, { f1: 'remote-folder' }),
      localFileIds: new Set(['f1']),
    });
    expect(result.fileParentIds.f1).toBe('remote-folder');
  });

  it('B9: local に無い（未 pull・隔離）file の remote parentId は carry over される', () => {
    const result = mergeStructure({
      base: known(),
      local: { folders: {}, fileParentIds: {} },
      remote: known({}, { quarantined: 'folder-x' }),
      localFileIds: new Set(), // quarantined は含めない
    });
    expect(result.fileParentIds.quarantined).toBe('folder-x');
  });

  it('B10: 両側同時削除 → no-op（deletedFolderIds には積む）', () => {
    const base = known({ a: folder('a') });
    const result = mergeStructure({
      base,
      local: { folders: {}, fileParentIds: {} },
      remote: known({}),
      localFileIds: new Set(),
    });
    expect(result.folders.a).toBeUndefined();
    expect(result.deletedFolderIds.has('a')).toBe(true);
  });

  it('B12: dangling parentId から folder を合成しない（folders dict のみが存在の正）', () => {
    const result = mergeStructure({
      base: known(),
      local: { folders: {}, fileParentIds: { f1: 'ghost-folder' } },
      remote: known(),
      localFileIds: new Set(['f1']),
    });
    expect(result.folders['ghost-folder']).toBeUndefined();
    // fileParentIds はそのまま保持される（repairParentReferences が適用時に解決する）。
    expect(result.fileParentIds.f1).toBe('ghost-folder');
  });
});

describe('mergeStructure — D: base（採用済み structure の写し）', () => {
  it('D1: base 無し（unknown）= 全 id 新規扱いで union、削除判定しない', () => {
    const result = mergeStructure({
      base: UNKNOWN,
      local: { folders: { a: folder('a') }, fileParentIds: {} },
      remote: known({ b: folder('b') }),
      localFileIds: new Set(),
    });
    expect(Object.keys(result.folders).sort()).toEqual(['a', 'b']);
    expect(result.deletedFolderIds.size).toBe(0);
  });

  it('D6: 冪等性（同じ入力を2回 merge しても同じ結果）', () => {
    const base = known({ a: folder('a', { name: '元' }) });
    const local = { folders: { a: folder('a', { name: 'local改名' }) }, fileParentIds: {} };
    const remote = known({ a: folder('a', { name: '元' }) });
    const r1 = mergeStructure({ base, local, remote, localFileIds: new Set() });
    const r2 = mergeStructure({ base, local, remote, localFileIds: new Set() });
    expect(r2.folders).toEqual(r1.folders);
    expect(r2.fileParentIds).toEqual(r1.fileParentIds);
    expect([...r2.deletedFolderIds]).toEqual([...r1.deletedFolderIds]);
  });
});

describe('mergeStructure — F: 不正入力（manifest 由来）', () => {
  it('F1: 自己参照 parentId は normalizeFolderRecord により null 化される', () => {
    const { folders } = normalizeRemoteFolders({ a: { name: 'A', parentId: 'a' } });
    expect(folders.a.parentId).toBeNull();
  });

  it('F2: folders の 1 レコード不正（非オブジェクト）→「不在」ではなく「不明」として local を保持する', () => {
    const base = known({ a: folder('a', { name: '元' }) });
    const result = mergeStructure({
      base,
      local: { folders: { a: folder('a', { name: '元' }) }, fileParentIds: {} },
      remote: parseRemoteStructure({ formatVersion: 3, rawFolders: { a: 'not-an-object' }, remoteFiles: {} }),
      localFileIds: new Set(),
    });
    // remote の壊れた値で 'フォルダ' 等の既定値に上書きされず、local の内容が残る。
    expect(result.folders.a).toEqual(folder('a', { name: '元' }));
    expect(result.deletedFolderIds.has('a')).toBe(false);
  });

  it('F3: key を id の正とし、value.id は採用しない', () => {
    const { folders } = normalizeRemoteFolders({ real: { id: 'spoofed', name: 'X' } });
    expect(folders.real).toBeDefined();
    expect(folders.real.id).toBe('real');
    expect(folders.spoofed).toBeUndefined();
  });

  it('F4: __proto__ / constructor を id に持つ folders は Object.create(null) と Object.hasOwn で無害化される', () => {
    const raw = JSON.parse('{"__proto__": {"name": "evil"}, "constructor": {"name": "evil2"}}');
    const { folders } = normalizeRemoteFolders(raw);
    expect(Object.getPrototypeOf(folders)).toBeNull();
    expect({}.polluted).toBeUndefined();
  });

  it('F5: name が不正なら normalizeFolderRecord の既定値（フォルダ）に倒れる', () => {
    const { folders } = normalizeRemoteFolders({ a: { name: 123 } });
    expect(folders.a.name).toBe('フォルダ');
  });

  it('F6: sortOrder が不正なら 0 に倒れる', () => {
    const { folders } = normalizeRemoteFolders({ a: { name: 'A', sortOrder: 'x' } });
    expect(folders.a.sortOrder).toBe(0);
  });
});

describe('parseRemoteStructure / readBaseStructure — missing ≠ empty', () => {
  it('formatVersion ≤2 は folders が存在していても unknown', () => {
    const result = parseRemoteStructure({ formatVersion: 2, rawFolders: { a: folder('a') }, remoteFiles: {} });
    expect(result.known).toBe(false);
  });

  it('formatVersion ≥3 で folders が非 dict なら unknown', () => {
    const result = parseRemoteStructure({ formatVersion: 3, rawFolders: ['not', 'a', 'dict'], remoteFiles: {} });
    expect(result.known).toBe(false);
  });

  it('formatVersion ≥3 で folders が dict なら known', () => {
    const result = parseRemoteStructure({ formatVersion: 3, rawFolders: {}, remoteFiles: {} });
    expect(result.known).toBe(true);
  });

  it('readBaseStructure はレコード欠落で unknown を返す', () => {
    expect(readBaseStructure(undefined).known).toBe(false);
    expect(readBaseStructure(null).known).toBe(false);
    expect(readBaseStructure({ id: STRUCTURE_BASE_KEY }).known).toBe(false);
  });

  it('readBaseStructure は folders/fileParentIds が揃っていれば known を返す', () => {
    const result = readBaseStructure({ id: STRUCTURE_BASE_KEY, folders: { a: folder('a') }, fileParentIds: { f1: 'a' } });
    expect(result.known).toBe(true);
    expect(result.folders.a.id).toBe('a');
    expect(result.fileParentIds.f1).toBe('a');
  });
});

describe('foldersArrayToDict / foldersDictToArray', () => {
  it('相互変換できる', () => {
    const arr = [folder('a'), folder('b')];
    const dict = foldersArrayToDict(arr);
    expect(Object.keys(dict).sort()).toEqual(['a', 'b']);
    expect(foldersDictToArray(dict).map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('非配列を渡しても空辞書を返す（防御的）', () => {
    expect(foldersArrayToDict(null)).toEqual({});
  });
});

describe('mergeStructure — K2: 性能（O(N)）', () => {
  it('数千件の folder / file を含む merge が同期的に完了する', () => {
    const N = 3000;
    const baseFolders = {};
    const localFolders = {};
    const remoteFolders = {};
    for (let i = 0; i < N; i++) {
      const id = `f${i}`;
      baseFolders[id] = folder(id, { name: `base${i}` });
      localFolders[id] = folder(id, { name: `local${i}` });
      remoteFolders[id] = folder(id, { name: `base${i}` }); // remote 側は未変更
    }
    const start = Date.now();
    const result = mergeStructure({
      base: known(baseFolders),
      local: { folders: localFolders, fileParentIds: {} },
      remote: known(remoteFolders),
      localFileIds: new Set(),
    });
    const elapsed = Date.now() - start;
    expect(Object.keys(result.folders)).toHaveLength(N);
    expect(result.folders.f0.name).toBe('local0'); // local だけが変化 → local 優先
    expect(elapsed).toBeLessThan(2000); // not-a-threshold（O(N) であることの smoke 確認）
  });
});

describe('STRUCTURE_BASE_KEY — D3', () => {
  it('FILE_ID_RE（[a-zA-Z0-9_-]{1,128}）に不適合で、実在 file/folder id と名前空間が衝突しない', () => {
    const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
    expect(FILE_ID_RE.test(STRUCTURE_BASE_KEY)).toBe(false);
  });
});

describe('normalizeRemoteFolders — #394 round2 item9: ID_RE 不適合な key の raw carryOver', () => {
  it('ID_RE 不適合な key（全角・末尾空白・ZWSP・129文字）は folders に入らず malformedIds へ積み、生値を保持する', () => {
    const longId = 'a'.repeat(129);
    const raw = {
      全角: { name: 'A' },
      'trailing ': { name: 'B' },
      'zwsp​': { name: 'C' },
      [longId]: { name: 'D' },
    };
    const { folders, malformedIds, rawMalformed } = normalizeRemoteFolders(raw);
    expect(Object.keys(folders)).toHaveLength(0);
    expect(malformedIds.has('全角')).toBe(true);
    expect(malformedIds.has('trailing ')).toBe(true);
    expect(malformedIds.has('zwsp​')).toBe(true);
    expect(malformedIds.has(longId)).toBe(true);
    expect(rawMalformed.全角).toEqual({ name: 'A' });
    expect(rawMalformed[longId]).toEqual({ name: 'D' });
  });

  it('不正 value（非オブジェクト）も malformedIds・rawMalformed 両方へ積む', () => {
    const { malformedIds, rawMalformed } = normalizeRemoteFolders({ a: 'not-an-object' });
    expect(malformedIds.has('a')).toBe(true);
    expect(rawMalformed.a).toBe('not-an-object');
  });
});

describe('mergeStructure — #394 round2 item11 (R-3): remote の無効な createdAt を発明しない', () => {
  it('remote の createdAt が無効（欠落）でも local の createdAt を保持し、2 回目の pass で変更判定されない', () => {
    const base = known({ a: folder('a', { name: 'A', createdAt: 1000 }) });
    const local = { folders: { a: folder('a', { name: 'A', createdAt: 1000 }) }, fileParentIds: {} };
    // remote の raw には createdAt が無い（normalizeRemoteFolders が既定値〔呼ぶたびに変わる
    // Date.now()〕へ倒す前提の入力）。
    const remote = parseRemoteStructure({
      formatVersion: 3, rawFolders: { a: { name: 'A' } }, remoteFiles: {},
    });

    const r1 = mergeStructure({ base, local, remote, localFileIds: new Set() });
    expect(r1.folders.a.createdAt).toBe(1000); // local/base を保持（Date.now() を発明しない）

    // 2 回目の pass（remote の raw createdAt は依然無効。normalizeFolderRecord なら毎回
    // 異なる既定値になるが、mergeStructure は local の値を保持しているため変化しない）。
    const remote2 = parseRemoteStructure({
      formatVersion: 3, rawFolders: { a: { name: 'A' } }, remoteFiles: {},
    });
    const r2 = mergeStructure({ base, local, remote: remote2, localFileIds: new Set() });
    expect(r2.folders.a.createdAt).toBe(1000);
  });
});
