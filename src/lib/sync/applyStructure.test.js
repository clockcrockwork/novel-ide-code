import { describe, expect, it, vi } from 'vitest';
import { applyStructure, cleanupOrphanedFolderMeta } from './applyStructure';

// #394 C-1 round2: applyStructureFromSync（AppContext.jsx）の実経路を fake I/O で直接検証する
// （R1: 以前は harness が onApplyStructure を自前スタブで差し替えていたため実装が未検証だった）。

function makeFakeIo({ folders = [], files = [], folderMetaMap = new Map() } = {}) {
  const state = { folders: [...folders], files: [...files] };
  const db = { folders: new Map(state.folders.map((f) => [f.id, f])), files: new Map(state.files.map((f) => [f.id, f])) };
  const metaDeletes = [];
  const workSettingsDeletes = [];
  return {
    state,
    db,
    metaDeletes,
    workSettingsDeletes,
    getFolders: () => state.folders,
    setFolders: (fn) => { state.folders = fn(state.folders); },
    getFiles: () => state.files,
    setFiles: (fn) => { state.files = fn(state.files); },
    dbPut: vi.fn((store, record) => {
      db[store].set(record.id, record);
      return Promise.resolve();
    }),
    dbDelete: vi.fn((store, id) => {
      db[store].delete(id);
      return Promise.resolve();
    }),
    getFolderMetaMap: () => folderMetaMap,
    collectOrphanedWorkIds: (ids, map) => {
      const workIds = new Set();
      for (const id of ids) {
        const meta = map.get(id);
        if (meta?.workId) workIds.add(meta.workId);
      }
      return workIds;
    },
    deleteWorkSettings: vi.fn((workId) => { workSettingsDeletes.push(workId); return Promise.resolve(); }),
    deleteFolderMeta: vi.fn((id) => { metaDeletes.push(id); return Promise.resolve(); }),
  };
}

function folder(id, over = {}) {
  return { id, name: id, parentId: null, sortOrder: 0, createdAt: 1000, ...over };
}

function file(id, over = {}) {
  return { id, name: `${id}.md`, content: id, parentId: null, updatedAt: 1000, createdAt: 1000, ...over };
}

describe('applyStructure', () => {
  it('(i) 同期パス中に作成された folder / file（merge 入力に無い id）は適用後も残る', async () => {
    const io = makeFakeIo({ folders: [folder('a')], files: [file('f1', { parentId: 'a' })] });
    // 往復中にユーザーが新しい folder / file を作成した（merge はこの id を知らない）。
    io.state.folders = [...io.state.folders, folder('new-folder')];
    io.state.files = [...io.state.files, file('new-file', { parentId: 'new-folder' })];

    const result = await applyStructure({
      folders: { a: folder('a') },
      fileParentIds: { f1: 'a' },
      deletedFolderIds: new Set(),
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.map((f) => f.id).sort()).toEqual(['a', 'new-folder']);
    expect(io.state.files.map((f) => f.id).sort()).toEqual(['f1', 'new-file']);
  });

  it('(ii) 往復中に編集された file の content / updatedAt は巻き戻らず、parentId だけが変わる', async () => {
    const io = makeFakeIo({
      folders: [folder('a'), folder('b')],
      files: [file('f1', { parentId: 'a', content: '旧本文', updatedAt: 1000 })],
    });
    // 同期パス中にユーザーが本文を編集した（merge のスナップショット後の変更）。
    io.state.files = [{ ...io.state.files[0], content: '新本文', updatedAt: 9999 }];

    const result = await applyStructure({
      folders: { a: folder('a'), b: folder('b') },
      fileParentIds: { f1: 'b' },
      deletedFolderIds: new Set(),
      io,
    });

    expect(result.ok).toBe(true);
    const f1 = io.state.files.find((f) => f.id === 'f1');
    expect(f1.content).toBe('新本文');
    expect(f1.updatedAt).toBe(9999);
    expect(f1.parentId).toBe('b');
  });

  it('(iii) remote 由来 folder 削除で folderMeta / orphan workSettings が消え、file entity は削除しない', async () => {
    const folderMetaMap = new Map([['a', { workId: 'work-a' }]]);
    const io = makeFakeIo({
      folders: [folder('a')],
      files: [file('f1', { parentId: 'a' })],
      folderMetaMap,
    });

    const result = await applyStructure({
      folders: {},
      fileParentIds: { f1: null },
      deletedFolderIds: new Set(['a']),
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.some((f) => f.id === 'a')).toBe(false);
    expect(io.db.folders.has('a')).toBe(false);
    expect(io.metaDeletes).toEqual(['a']);
    expect(io.workSettingsDeletes).toEqual(['work-a']);
    // file entity は削除しない（C3）。孤児は repair で root（parentId: null）へ。
    expect(io.state.files.some((f) => f.id === 'f1')).toBe(true);
    expect(io.state.files.find((f) => f.id === 'f1').parentId).toBeNull();
  });

  it('(iv) dangling parentId から folder を合成せず root へ倒す', async () => {
    const io = makeFakeIo({
      folders: [folder('a', { parentId: 'missing-parent' })],
      files: [file('f1', { parentId: 'a' })],
    });

    const result = await applyStructure({
      folders: { a: folder('a', { parentId: 'missing-parent' }) },
      fileParentIds: { f1: 'a' },
      deletedFolderIds: new Set(),
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.find((f) => f.id === 'a').parentId).toBeNull();
    expect(result.folders.find((f) => f.id === 'a').parentId).toBeNull();
  });

  it('(v) dbPut 失敗は throw する（D5: 呼び出し側が snapshot を不成立にできる）', async () => {
    const io = makeFakeIo({ folders: [], files: [] });
    io.dbPut.mockRejectedValueOnce(new Error('idb write failed'));

    await expect(applyStructure({
      folders: { a: folder('a') },
      fileParentIds: {},
      deletedFolderIds: new Set(),
      io,
    })).rejects.toThrow('idb write failed');
  });

  // #394 C-1 round5 (F1): merge の local 入力に使った snapshot とライブ値を突き合わせ、
  // 同期パス開始後（merge 計算〜適用までの窓）にユーザーが行った変更を保護する。
  it('(vi) 窓中にユーザーが削除した folder は（merge が upsert しようとしても）復活しない', async () => {
    const snapshotFolders = { a: folder('a') };
    // live は既に削除済み（deleteFolder が dbDelete/store 更新を済ませた状態を模す）。
    const io = makeFakeIo({ folders: [], files: [] });

    const result = await applyStructure({
      // merge は snapshot 時点の値のまま upsert しようとする（remote/base 側は不変だった）。
      folders: { a: folder('a') },
      fileParentIds: {},
      deletedFolderIds: new Set(),
      localSnapshot: { folders: snapshotFolders, fileParentIds: {} },
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.some((f) => f.id === 'a')).toBe(false);
    expect(io.db.folders.has('a')).toBe(false);
  });

  it('(vii) 窓中に rename した folder は merge の古い名前で上書きされない', async () => {
    const snapshotFolders = { a: folder('a', { name: '旧名' }) };
    const io = makeFakeIo({ folders: [folder('a', { name: '新名' })], files: [] });

    const result = await applyStructure({
      folders: { a: folder('a', { name: '旧名' }) },
      fileParentIds: {},
      deletedFolderIds: new Set(),
      localSnapshot: { folders: snapshotFolders, fileParentIds: {} },
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.find((f) => f.id === 'a').name).toBe('新名');
    expect(io.dbPut).not.toHaveBeenCalledWith('folders', expect.objectContaining({ id: 'a', name: '旧名' }));
  });

  it('(viii) 窓中に移動した file の parentId は merge の古い値へ差し戻されない', async () => {
    const io = makeFakeIo({
      folders: [folder('a'), folder('b')],
      // 窓中に 'a' → 'b' へ移動済み（moveFile が既に反映した状態を模す）。
      files: [file('f1', { parentId: 'b' })],
    });

    const result = await applyStructure({
      folders: { a: folder('a'), b: folder('b') },
      fileParentIds: { f1: 'a' }, // merge は snapshot 時点の 'a' のまま
      deletedFolderIds: new Set(),
      localSnapshot: { folders: { a: folder('a'), b: folder('b') }, fileParentIds: { f1: 'a' } },
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.files.find((f) => f.id === 'f1').parentId).toBe('b');
  });

  it('(ix) 窓中に変化が無いレコードは従来どおり適用される', async () => {
    const io = makeFakeIo({
      folders: [folder('a', { name: '旧名' }), folder('b')],
      files: [file('f1', { parentId: 'a' })],
    });

    const result = await applyStructure({
      folders: { a: folder('a', { name: '新名（remote 側の変更）' }), b: folder('b') },
      fileParentIds: { f1: 'b' },
      deletedFolderIds: new Set(),
      localSnapshot: {
        folders: { a: folder('a', { name: '旧名' }), b: folder('b') }, // live と一致（未変更）
        fileParentIds: { f1: 'a' }, // live の現在値と一致
      },
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.folders.find((f) => f.id === 'a').name).toBe('新名（remote 側の変更）');
    expect(io.state.files.find((f) => f.id === 'f1').parentId).toBe('b');
  });

  // #394 C-1 round6 (item21): snapshot 側（buildLocalFileParentIds）は parentId を文字列以外
  // なら null に正規化するが、live の生レコードは GitHub から開いた file・競合「両方保持」の
  // 複製等で parentId キー自体を持たず undefined になりうる。正規化せずに比較すると
  // `null !== undefined` で恒久的に不一致となり、remote 由来の parentId が二度と適用されない。
  it('(x) parentId キーを持たない live file にも remote の parentId が適用される（正規化して比較する）', async () => {
    const io = makeFakeIo({
      folders: [folder('fa')],
      // parentId キー自体が無い（GitHub から開いた file 等を模す）。
      files: [{ id: 'f1', name: 'f1.md', content: 'f1', updatedAt: 1000, createdAt: 1000 }],
    });

    const result = await applyStructure({
      folders: { fa: folder('fa') },
      fileParentIds: { f1: 'fa' },
      deletedFolderIds: new Set(),
      localSnapshot: {
        folders: { fa: folder('fa') },
        // buildLocalFileParentIds は parentId 欠落を null に正規化する。
        fileParentIds: { f1: null },
      },
      io,
    });

    expect(result.ok).toBe(true);
    expect(io.state.files.find((f) => f.id === 'f1').parentId).toBe('fa');
    expect(io.db.files.get('f1').parentId).toBe('fa');
    expect(result.fileParentIds.f1).toBe('fa');
  });
});

describe('cleanupOrphanedFolderMeta', () => {
  it('deletedFolderIds が空なら何もしない', async () => {
    const io = makeFakeIo();
    await cleanupOrphanedFolderMeta(new Set(), io);
    expect(io.metaDeletes).toEqual([]);
    expect(io.workSettingsDeletes).toEqual([]);
  });
});
