import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyStructure } from './sync/applyStructure';
import { flattenTree } from './fileTree';

// 2 端末結合テスト（#394 C-1 完了条件1・10）。in-memory fake remote（実 fetch は打たない）。
//
// sync.js は _snapshotRef 等のモジュール内 singleton state を持つため、1 プロセス内で
// 複数「端末」を模擬するには端末ごとに vi.resetModules() + vi.doMock() で別モジュール
// インスタンスを作る（sync.test.js 末尾の「このファイルの最後に置く」ブロックと同じ手法）。
// AppContext の代わりに、各端末は自前の filesList/foldersList（配列）と fake IDB
// （Map ベース）を持ち、onApplyStructure/onPullFile で AppContext と同じ責務
// （repairParentReferences を通した適用・部分更新）を最小限担う。

function makeFakeRemote() {
  // 既定で「workspace は存在するが空」の v3 manifest を持つ（テストの主眼は init 分岐
  // ではなく structure merge のため、init 経路を経由させない。E1 は remote.manifest を
  // v2 形状へ明示的に上書きして migration を検証する）。
  return {
    manifest: { version: 3, updatedAt: new Date().toISOString(), fileOrder: [], files: {}, folders: {} },
    manifestSha: 0,
    files: new Map(),
  };
}

function okResponse(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function failResponse(status, code) {
  return { ok: false, status, json: () => Promise.resolve({ code }) };
}

function makeFakeWorkerClient(remote) {
  async function get(path) {
    if (path === '/sync/manifest') {
      if (!remote.manifest) return failResponse(404, 'sync_manifest_missing');
      return okResponse({ ...remote.manifest, _sha: String(remote.manifestSha), _branch: 'main' });
    }
    const m = /^\/sync\/file\/(.+)$/.exec(path);
    if (m) {
      const entity = remote.files.get(m[1]);
      if (!entity) return failResponse(404, 'sync_content_missing');
      return okResponse({ ...entity.body, _sha: entity.sha });
    }
    return failResponse(404, 'sync_content_missing');
  }

  async function put(path, opts) {
    if (path === '/sync/init') return okResponse({ created: false, branch: 'main' });
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
    if (path === '/sync/manifest') {
      const { _sha, _branch: _b, ...manifest } = body;
      if (remote.manifest && String(remote.manifestSha) !== _sha) {
        return failResponse(409, 'sync_manifest_stale');
      }
      if (!remote.manifest && _sha) return failResponse(409, 'sync_manifest_stale');
      remote.manifestSha += 1;
      remote.manifest = manifest;
      return okResponse({ sha: String(remote.manifestSha) });
    }
    const fm = /^\/sync\/file\/(.+)$/.exec(path);
    if (fm) {
      const id = fm[1];
      const { _sha, _branch: _b, _manifestSha: _m, _reconcile, ...file } = body;
      const existing = remote.files.get(id);
      if (_reconcile) {
        const newSha = String(Date.now()) + Math.random();
        remote.files.set(id, { body: file, sha: newSha });
        return okResponse({ sha: newSha });
      }
      if (existing && existing.sha !== _sha) return failResponse(409, 'sync_entity_stale');
      if (!existing && _sha) return failResponse(409, 'sync_entity_orphan');
      const newSha = `${id}-${(existing ? Number(existing.sha.split('-')[1] ?? 0) : 0) + 1}`;
      remote.files.set(id, { body: file, sha: newSha });
      return okResponse({ sha: newSha });
    }
    if (path.startsWith('/sync/devices/')) return okResponse({ sha: 'device-sha' });
    if (path === '/sync/init') return okResponse({ created: false, branch: 'main' });
    return okResponse({ ok: true });
  }

  const workerFetch = vi.fn((path) => get(path));
  const workerFetchWithCSRF = vi.fn((path, opts = {}) =>
    opts.method === 'PUT' || opts.method === 'POST' ? put(path, opts) : get(path),
  );
  return { workerFetch, workerFetchWithCSRF };
}

function makeFakeDb() {
  const stores = { files: new Map(), folders: new Map(), syncState: new Map(), meta: new Map() };
  return {
    stores,
    dbGet: vi.fn((store, id) => Promise.resolve(stores[store]?.get(id))),
    dbPut: vi.fn((store, rec) => {
      stores[store]?.set(rec.id, rec);
      return Promise.resolve();
    }),
    dbDelete: vi.fn((store, id) => {
      stores[store]?.delete(id);
      return Promise.resolve();
    }),
  };
}

async function createDevice(remote, { files = [], folders = [] } = {}) {
  const db = makeFakeDb();
  const client = makeFakeWorkerClient(remote);
  vi.resetModules();
  vi.doMock('./db', () => ({ dbGet: db.dbGet, dbPut: db.dbPut, dbDelete: db.dbDelete }));
  vi.doMock('./workerClient', () => ({
    workerFetch: client.workerFetch, workerFetchWithCSRF: client.workerFetchWithCSRF,
  }));
  const syncMod = await import('./sync');
  return { db, client, syncMod, filesList: [...files], foldersList: [...folders] };
}

// AppContext.applyStructureFromSync の実経路（#394 C-1 round2 R1: 以前は onApplyStructure を
// 自前スタブで差し替えていたため、実装〔src/lib/sync/applyStructure.js〕がこの harness では
// 未検証だった。fake I/O を注入して同じ関数を呼ぶ）。
async function runSync(device, deviceId = 'dev') {
  const onApplyStructure = (args) => applyStructure({
    ...args,
    io: {
      getFolders: () => device.foldersList,
      setFolders: (fn) => { device.foldersList = fn(device.foldersList); },
      getFiles: () => device.filesList,
      setFiles: (fn) => { device.filesList = fn(device.filesList); },
      dbPut: (store, rec) => device.db.dbPut(store, rec),
      dbDelete: (store, id) => device.db.dbDelete(store, id),
      getFolderMetaMap: () => new Map(),
      collectOrphanedWorkIds: () => new Set(),
      deleteWorkSettings: () => Promise.resolve(),
      deleteFolderMeta: () => Promise.resolve(),
    },
  });
  await device.syncMod.syncAll({
    files: device.filesList,
    deviceId,
    branch: 'main',
    folders: device.foldersList,
    filesLoaded: true,
    foldersLoaded: true,
    onApplyStructure,
    onPullFile: (pulled) => {
      const idx = device.filesList.findIndex((f) => f.id === pulled.id);
      if (idx >= 0) device.filesList = device.filesList.map((f, i) => (i === idx ? { ...f, ...pulled } : f));
      else device.filesList = [...device.filesList, pulled];
    },
    onPushFile: () => {},
    onBranch: () => {},
  });
  return device.syncMod.getSyncStatus();
}

function folder(id, over = {}) {
  return { id, name: id, parentId: null, sortOrder: 0, createdAt: 1000, ...over };
}

function file(id, over = {}) {
  return { id, name: `${id}.md`, content: id, github: null, updatedAt: 1000, createdAt: 1000, parentId: null, ...over };
}

function expandAll(folders) {
  return new Set(folders.map((f) => f.id));
}

afterEach(() => {
  vi.doUnmock('./db');
  vi.doUnmock('./workerClient');
  vi.resetModules();
});

describe('2 端末結合（#394 C-1 完了条件1・10）', () => {
  it('A1/A2/A3/A4: 多階層フォルダと file の parentId・表示順が別端末に復元される', async () => {
    const remote = makeFakeRemote();
    const work = folder('work', { name: '作品', sortOrder: 0 });
    const chapter = folder('chapter', { name: '第1章', parentId: 'work', sortOrder: 0 });
    const ch1 = file('ch1', { name: '1.md', parentId: 'chapter', createdAt: 100 });
    const ch2 = file('ch2', { name: '2.md', parentId: 'chapter', createdAt: 200 });

    const x = await createDevice(remote, { files: [ch1, ch2], folders: [work, chapter] });
    const statusX = await runSync(x, 'x');
    expect(statusX.errorCategory).toBeNull();

    // Y は最初から空（別端末・新規 hydrate 相当）。
    const y = await createDevice(remote, { files: [], folders: [] });
    const statusY = await runSync(y, 'y');
    expect(statusY.errorCategory).toBeNull();

    expect(y.foldersList.map((f) => f.id).sort()).toEqual(['chapter', 'work']);
    expect(y.filesList.find((f) => f.id === 'ch1').parentId).toBe('chapter');
    expect(y.filesList.find((f) => f.id === 'ch2').parentId).toBe('chapter');

    // A2: 多階層 — flattenTree の depth が両端末で一致する（フル展開）。
    const xTree = flattenTree(x.filesList, x.foldersList, expandAll(x.foldersList));
    const yTree = flattenTree(y.filesList, y.foldersList, expandAll(y.foldersList));
    expect(yTree.map((n) => n.id)).toEqual(xTree.map((n) => n.id));
    expect(yTree.find((n) => n.id === 'chapter').depth).toBe(1);
    expect(yTree.find((n) => n.id === 'ch1').depth).toBe(2);

    // A3: file の表示順（createdAt）。
    const chapterChildren = yTree.filter((n) => n.kind === 'file');
    expect(chapterChildren.map((n) => n.id)).toEqual(['ch1', 'ch2']);

    // A4: Y の fake IDB（store 相当）にも folders/files の両方が反映されている。
    expect(y.db.stores.folders.has('work')).toBe(true);
    expect(y.db.stores.folders.has('chapter')).toBe(true);
    expect(y.db.stores.files.get('ch1')?.parentId).toBe('chapter');
  });

  it('B3: 両側で別 folder を作成 → union（互いに相手の新規を保持する）', async () => {
    const remote = makeFakeRemote();
    const a = await createDevice(remote, { files: [], folders: [folder('a')] });
    await runSync(a, 'a');
    const b = await createDevice(remote, { files: [], folders: [] });
    // b は a の folder を pull しつつ、自分の folder も持っている（同時作成を模擬）。
    b.foldersList = [folder('b')];
    await runSync(b, 'b');

    expect(b.foldersList.map((f) => f.id).sort()).toEqual(['a', 'b']);

    // a がもう一度同期すれば b の folder も見える。
    await runSync(a, 'a');
    expect(a.foldersList.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('B7: 古い base の端末が復帰、相手が多数追加していても削除と誤判定しない', async () => {
    const remote = makeFakeRemote();
    const a = await createDevice(remote, { files: [], folders: [folder('a')] });
    await runSync(a, 'a'); // base(a) = {a}

    const b = await createDevice(remote, { files: [], folders: [] });
    await runSync(b, 'b'); // b は a を pull
    b.foldersList = [...b.foldersList, folder('b1'), folder('b2')];
    await runSync(b, 'b'); // base(b) = {a,b1,b2}

    // a は自分の base（{a} のみ）のまま復帰して同期する。b1/b2 は a の base に無いが、
    // 削除とは判定せず保持されなければならない。
    await runSync(a, 'a');
    expect(a.foldersList.map((f) => f.id).sort()).toEqual(['a', 'b1', 'b2']);
  });

  it('B11: folder 削除 × 配下への新規 file 追加は、どちらの順でも収束する（file は削除しない）', async () => {
    for (const order of ['delete-first', 'file-first']) {
      const remote = makeFakeRemote();
      const a = await createDevice(remote, { files: [], folders: [folder('shared')] });
      await runSync(a, 'a');
      const b = await createDevice(remote, { files: [], folders: [] });
      await runSync(b, 'b'); // b は shared を pull 済み

      if (order === 'delete-first') {
        a.foldersList = [];
        await runSync(a, 'a');
        b.filesList = [file('newfile', { parentId: 'shared' })];
        await runSync(b, 'b');
        await runSync(a, 'a'); // a が b の新規 file を pull
      } else {
        b.filesList = [file('newfile', { parentId: 'shared' })];
        await runSync(b, 'b');
        a.foldersList = [];
        await runSync(a, 'a');
        await runSync(b, 'b'); // b が a の削除を反映
      }

      // 両順序とも: folder は削除され、file は削除されず root（parentId:null）に repair される。
      expect(a.foldersList.find((f) => f.id === 'shared')).toBeUndefined();
      expect(b.foldersList.find((f) => f.id === 'shared')).toBeUndefined();
      const newfileOnA = a.filesList.find((f) => f.id === 'newfile');
      const newfileOnB = b.filesList.find((f) => f.id === 'newfile');
      expect(newfileOnA).toBeDefined();
      expect(newfileOnB).toBeDefined();
      expect(newfileOnA.parentId).toBeNull();
      expect(newfileOnB.parentId).toBeNull();
    }
  });

  it('C1（現状固定・非目的）: deleteAll 相当の配下 file は remote に残り root へ復活する', async () => {
    const remote = makeFakeRemote();
    const a = await createDevice(remote, {
      files: [file('child')], folders: [folder('parent')],
    });
    a.filesList[0].parentId = 'parent';
    await runSync(a, 'a');

    // b は parent と child(parentId=parent) を pull 済み。
    const b = await createDevice(remote, { files: [], folders: [] });
    await runSync(b, 'b');
    expect(b.filesList.find((f) => f.id === 'child')?.parentId).toBe('parent');

    // a が「deleteAll」相当（folder ごと消す。C-1 は file 削除伝搬をしないので file は
    // ローカルにまだ残る想定だが、この harness は folder だけ消して file はそのまま
    // 残す＝deleteAll の意図を folder 側だけで模擬する）。
    a.foldersList = [];
    await runSync(a, 'a');

    // b が同期すると、folder は削除されるが child は削除されず root へ復活する（C1 現状）。
    await runSync(b, 'b');
    expect(b.foldersList.find((f) => f.id === 'parent')).toBeUndefined();
    const child = b.filesList.find((f) => f.id === 'child');
    expect(child).toBeDefined();
    expect(child.parentId).toBeNull();
  });

  it('C2: moveToParent（folder 削除＋子を親へ昇格）が伝搬する', async () => {
    const remote = makeFakeRemote();
    const root = folder('root');
    const mid = folder('mid', { parentId: 'root' });
    const leaf = folder('leaf', { parentId: 'mid' });
    const a = await createDevice(remote, { files: [], folders: [root, mid, leaf] });
    await runSync(a, 'a');

    // moveToParent: mid を削除し、leaf を root 直下へ昇格する（AppContext.deleteFolder と同じ意図）。
    a.foldersList = [root, { ...leaf, parentId: 'root' }];
    await runSync(a, 'a');

    const b = await createDevice(remote, { files: [], folders: [] });
    await runSync(b, 'b');
    expect(b.foldersList.find((f) => f.id === 'mid')).toBeUndefined();
    expect(b.foldersList.find((f) => f.id === 'leaf')?.parentId).toBe('root');
  });

  it('E1: remote v2（folders 無し）からの初回移行で local の folders/parentId を失わない', async () => {
    const remote = makeFakeRemote();
    // 旧 client が書いた v2 manifest（folders フィールドが無い）。
    remote.manifest = { version: 2, updatedAt: new Date().toISOString(), fileOrder: [], files: {} };
    remote.manifestSha = 1;

    const x = await createDevice(remote, { files: [file('c1', { parentId: 'w1' })], folders: [folder('w1')] });
    const status = await runSync(x, 'x');
    expect(status.errorCategory).toBeNull();

    // v3 へ書き換わり、local の folders/parentId が失われていない。
    expect(remote.manifest.version).toBe(3);
    expect(remote.manifest.folders).toHaveProperty('w1');
    expect(remote.manifest.files.c1.parentId).toBe('w1');
    expect(x.foldersList.map((f) => f.id)).toEqual(['w1']);
  });

  it('E2/E3: migration 中に remote manifest が変わっていれば snapshot は成立せずやり直しになる', async () => {
    const remote = makeFakeRemote();
    remote.manifest = { version: 2, updatedAt: new Date().toISOString(), fileOrder: [], files: {} };
    remote.manifestSha = 1;

    const x = await createDevice(remote, { files: [], folders: [folder('w1')] });
    // manifest PUT が常に 409（他端末が進めている想定）を返すよう固定する。
    const originalPut = x.client.workerFetchWithCSRF.getMockImplementation();
    let putAttempts = 0;
    x.client.workerFetchWithCSRF.mockImplementation((path, opts = {}) => {
      if (path === '/sync/manifest' && opts.method === 'PUT') {
        putAttempts += 1;
        return Promise.resolve(failResponse(409, 'sync_manifest_stale'));
      }
      return originalPut(path, opts);
    });

    const status = await runSync(x, 'x');

    // 1 回だけ再試行し、それでも失敗すれば snapshot は成立しない（conflict category）。
    expect(putAttempts).toBe(2);
    expect(status.errorCategory).toBe('conflict');
    expect(status.lastSyncedAt).toBeNull();
    // remote の manifest は書き換わっていない（v2 のまま）。
    expect(remote.manifest.version).toBe(2);
  });

  it('H1: hydrate 未完了（filesLoaded/foldersLoaded=false）なら remote の folders を消さない', async () => {
    const remote = makeFakeRemote();
    const seed = await createDevice(remote, { files: [], folders: [folder('w1')] });
    await runSync(seed, 'seed');
    expect(remote.manifest.folders).toHaveProperty('w1');

    // 別端末が、まだ hydrate 完了していない状態（folders=[] だが本当は未ロードなだけ）で
    // triggerSync 相当を呼ぶ。
    const late = await createDevice(remote, { files: [], folders: [] });
    await late.syncMod.syncAll({
      files: [], deviceId: 'late', branch: 'main',
      folders: [], filesLoaded: false, foldersLoaded: false,
      onBranch: () => {},
    });

    // remote の folders は消えていない（H1: structure は unknown として carry over される）。
    expect(remote.manifest.folders).toHaveProperty('w1');
  });

  it('N-A1（item12 / SP1 回帰）: 他端末が本文編集した既存 file を pull しても IDB の parentId が残る', async () => {
    const remote = makeFakeRemote();
    const folderA = folder('fa');
    // x が作成し、folderA 配下に置いた file を先に同期する。
    const x = await createDevice(remote, { files: [file('shared', { parentId: 'fa', content: '旧本文' })], folders: [folderA] });
    await runSync(x, 'x');

    // y がその file を pull し、folder 配下に置いたまま IDB へ持つ。
    const y = await createDevice(remote, { files: [], folders: [] });
    await runSync(y, 'y');
    expect(y.filesList.find((f) => f.id === 'shared').parentId).toBe('fa');
    expect(y.db.stores.files.get('shared').parentId).toBe('fa');
    // 2 回目（変更なし・idle pass）で adoptedHash を確定させる（新規 pull 直後は
    // syncState.adoptedHash が未確定 — 既存の別経路。#394 とは無関係のため回避する）。
    await runSync(y, 'y');

    // x が本文を編集して再同期する（remote の entity payload は parentId を持たない）。
    x.filesList = x.filesList.map((f) => (f.id === 'shared' ? { ...f, content: '新本文', updatedAt: f.updatedAt + 1 } : f));
    await runSync(x, 'x');

    // y が pull する。IDB の parentId は消えず、store にも残る（SP1: 全置換で失わない）。
    await runSync(y, 'y');
    expect(y.filesList.find((f) => f.id === 'shared').content).toBe('新本文');
    expect(y.filesList.find((f) => f.id === 'shared').parentId).toBe('fa');
    expect(y.db.stores.files.get('shared').parentId).toBe('fa');

    // reload 相当（IDB から再構築しても parentId は残っている）。次回 pass でも変わらない。
    await runSync(y, 'y');
    expect(y.db.stores.files.get('shared').parentId).toBe('fa');
  });

  it('item19/F2: remote version が文字列 "3" に破損しても空端末の同期で folders を失わず、A の再同期で復元する', async () => {
    const remote = makeFakeRemote();
    const work = folder('work', { name: '作品' });
    const a = await createDevice(remote, { files: [], folders: [work] });
    await runSync(a, 'a');
    expect(remote.manifest.folders).toHaveProperty('work');
    expect(remote.manifest.version).toBe(3);

    // 手編集等で version が文字列化した破損（parseFormatVersion が LEGACY_DEFAULT(2) へ
    // 倒すため、known 判定は formatVersion 側で false になる。folders 自体は妥当な dict）。
    remote.manifest.version = '3';

    // 空端末（新規インストール・IDB クリア後）が同期する。local に folder が無いため
    // unknown を空へ確定させず、folders は生 carryOver されるはず（F2）。
    const c = await createDevice(remote, { files: [], folders: [] });
    const statusC = await runSync(c, 'c');
    expect(statusC.errorCategory).toBeNull();
    expect(remote.manifest.folders).toHaveProperty('work');

    // A が再同期しても folders を失わない（local に folder があるため E1 として v3 で
    // 自分の folders を書き直し、version も復元する）。
    const statusA2 = await runSync(a, 'a');
    expect(statusA2.errorCategory).toBeNull();
    expect(remote.manifest.folders).toHaveProperty('work');
    expect(remote.manifest.version).toBe(3);
  });

  it('item21: B が GitHub から開いた file（parentId キー無し）を A が folder へ入れて同期しても、B の push で配置が壊れない', async () => {
    const remote = makeFakeRemote();
    // B の g1 は parentId キー自体を持たない（GitHub から開いた file を模す）。
    const g1 = { id: 'g1', name: 'g1.md', content: 'g1', github: null, updatedAt: 1000, createdAt: 1000 };
    const b = await createDevice(remote, { files: [g1], folders: [] });
    await runSync(b, 'b');

    // A が g1 を pull し、新しい folder 'fa' を作って g1 をそこへ移動する。
    const a = await createDevice(remote, { files: [], folders: [] });
    await runSync(a, 'a');
    expect(a.filesList.find((f) => f.id === 'g1')).toBeDefined();
    a.foldersList = [...a.foldersList, folder('fa')];
    a.filesList = a.filesList.map((f) => (f.id === 'g1' ? { ...f, parentId: 'fa' } : f));
    const statusA = await runSync(a, 'a');
    expect(statusA.errorCategory).toBeNull();
    expect(remote.manifest.folders).toHaveProperty('fa');
    expect(remote.manifest.files.g1.parentId).toBe('fa');

    // B が同期すると folder 'fa' が反映され、g1 がそこへ入る。
    const statusB = await runSync(b, 'b');
    expect(statusB.errorCategory).toBeNull();
    expect(b.foldersList.map((f) => f.id)).toContain('fa');
    expect(b.filesList.find((f) => f.id === 'g1').parentId).toBe('fa');
    expect(b.db.stores.files.get('g1').parentId).toBe('fa');

    // B の push で A の配置が壊れない（remote が null へ巻き戻らない）。
    expect(remote.manifest.files.g1.parentId).toBe('fa');

    // A が再同期しても配置は 'fa' のまま。
    const statusA2 = await runSync(a, 'a');
    expect(statusA2.errorCategory).toBeNull();
    expect(a.filesList.find((f) => f.id === 'g1').parentId).toBe('fa');
  });
});
