import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// db.js は IndexedDB を直接叩くため、このリポジトリに前例のある「db.js をモックして
// 呼び出し側をテストする」方式が使えない（テスト対象そのものが db.js）。
// fake-indexeddb 等の依存は未導入（前例0件）のため、dbGetAllStores が使う最小限の
// IDB API（objectStoreNames / transaction / objectStore(...).getAll()）だけを持つ
// 最小フェイクで薄く検証する。詳細な正常系・除外ロジックの検証は backup.test.js に寄せる。
//
// installFakeIndexedDBWithWrites は preserveKeys（#216 / #219 B8）検証のため
// getAll の tx 内解決（data / keyPathByStore オプション）を最小拡張済み。新しいテスト基盤は
// 作らず、この既存フェイクを拡張する方針を踏襲する。

function makeRequest() {
  return { onsuccess: null, onerror: null, result: undefined };
}

function installFakeIndexedDB({ storeNames, data = {}, failStore } = {}) {
  const dataMap = new Map(Object.entries(data));
  const transactionSpy = vi.fn((names, mode) => {
    const requests = [];
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null, mode };
    tx.objectStore = (name) => ({
      getAll: () => {
        const req = makeRequest();
        requests.push({ name, req });
        return req;
      },
    });
    queueMicrotask(() => {
      if (failStore && Array.from(names).includes(failStore)) {
        tx.error = new Error(`getAll failed for ${failStore}`);
        tx.onerror?.();
        return;
      }
      for (const { name, req } of requests) {
        req.result = dataMap.get(name) ?? [];
        req.onsuccess?.();
      }
      tx.oncomplete?.();
    });
    return tx;
  });

  const fakeDb = { objectStoreNames: storeNames, transaction: transactionSpy };

  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => {
        req.result = fakeDb;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  });

  return { transactionSpy };
}

describe('dbGetAllStores（全データバックアップ #216 / #219）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('全ストアを1つの readonly トランザクションで読み出す', async () => {
    const { transactionSpy } = installFakeIndexedDB({
      storeNames: ['files', 'meta'],
      data: {
        files: [{ id: 'f1', name: 'a.md' }],
        meta: [{ key: 'deviceId', value: 'd1' }],
      },
    });
    const { dbGetAllStores } = await import('./db');

    const result = await dbGetAllStores();

    expect(result.files).toEqual([{ id: 'f1', name: 'a.md' }]);
    expect(result.meta).toEqual([{ key: 'deviceId', value: 'd1' }]);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy.mock.calls[0][1]).toBe('readonly');
  });

  it('戻り値は Object.create(null) ベース（プロトタイプ汚染対策 INVARIANTS #11）', async () => {
    installFakeIndexedDB({ storeNames: ['files'], data: { files: [] } });
    const { dbGetAllStores } = await import('./db');

    const result = await dbGetAllStores();

    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('ストアが1つも無い場合は空の辞書を返す', async () => {
    installFakeIndexedDB({ storeNames: [] });
    const { dbGetAllStores } = await import('./db');

    const result = await dbGetAllStores();

    expect(result).toEqual({});
  });

  it('トランザクション失敗時は reject する（握りつぶさない）', async () => {
    installFakeIndexedDB({ storeNames: ['files'], failStore: 'files' });
    const { dbGetAllStores } = await import('./db');

    await expect(dbGetAllStores()).rejects.toThrow();
  });
});

// E1: 出力対象ストアの集合は db.objectStoreNames から動的に取れる一方、除外は静的
// （backup.js の META_EXCLUDED_KEYS）なので、新ストア追加は何のゲートも無く
// バックアップに入る。getDb() の実スキーマ定義（createObjectStore 呼び出し）を
// 実行させ、作成されるストア名の集合を固定することで、ストアを増減させた人を
// 一度立ち止まらせる（DB_VERSION のリテラル固定と同じ意図）。
// ストア追加時に必要な backup / restore 側の更新一覧は docs/data-model/INVARIANTS.md #8 を参照。
describe('getDb() が作成するストア集合の固定（全データバックアップ #216 / #219）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createObjectStore で作成されるストア名の集合が現在の13個から変わらない', async () => {
    const createdStoreNames = [];
    const fakeDb = {
      objectStoreNames: { contains: () => false },
      createObjectStore: (name) => {
        createdStoreNames.push(name);
        return {};
      },
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
        queueMicrotask(() => {
          // oldVersion を DB_VERSION 超に設定し、localStorage マイグレーション／
          // メタデータシードの副作用（localStorage・crypto 依存）を経由せず
          // createObjectStore 呼び出しだけを観測する。
          req.onupgradeneeded?.({
            target: { result: fakeDb, transaction: undefined },
            oldVersion: 99,
          });
          req.result = fakeDb;
          req.onsuccess?.({ target: req });
        });
        return req;
      },
    });

    const { getDb } = await import('./db');
    await getDb();

    expect(createdStoreNames.slice().sort()).toEqual(
      [
        'annotations',
        'customFieldDefs',
        'fileMetadata',
        'files',
        'folderMeta',
        'folders',
        'kindDefinitions',
        'meta',
        'settings',
        'statusDefinitions',
        'syncState',
        'workSettings',
        'workspaceSettings',
      ].sort(),
    );
  });
});

// E3: フェイク IDB は従来 tx.onerror しか発火させていなかったため、abort 経路
// （実 IDB では quota 超過・db.close()・eviction で発生する）と、oncomplete 前に
// resolve してしまう変異（＝一部ストアしか読めていないのに「完全なバックアップ」
// として出力される、この機能で最も避けたい失敗）が敵対的レビューで素通りした。
// individual の getAll 成功と tx レベルの完了/中断を別々に手動発火できる
// フェイクで、この2つの経路を直接検証する。
function installControllableFakeIndexedDB({ storeNames }) {
  const requestsByStore = new Map();
  let tx = null;
  const fakeDb = {
    objectStoreNames: storeNames,
    transaction: (names, mode) => {
      tx = { oncomplete: null, onerror: null, onabort: null, error: null, mode };
      tx.objectStore = (name) => ({
        getAll: () => {
          const req = makeRequest();
          requestsByStore.set(name, req);
          return req;
        },
      });
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => {
        req.result = fakeDb;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  });
  return {
    resolveStore: (name, result) => {
      const req = requestsByStore.get(name);
      req.result = result;
      req.onsuccess?.();
    },
    completeTx: () => tx.oncomplete?.(),
    abortTx: (err) => {
      tx.error = err;
      tx.onabort?.();
    },
  };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// withAllStoresTx 共通化（#216 / #219 JSON バックアップ復元）: dbClearAll / dbRestoreAllStores が
// 発行する clear() / put() 呼び出しを記録できるフェイク。呼び出し順序（clear → put）と
// 対象ストアの集合、tx の mode / abort 伝播を検証するために使う。
// data / keyPathByStore は dbRestoreAllStores の preserveKeys（B8）検証用の拡張:
// getAll() は data[name]（無ければ空配列）で解決し、tx.objectStore(name).keyPath は
// keyPathByStore[name] を返す。getAll の onsuccess は最初のマイクロタスクで発火させ、
// そのハンドラ内から同期的に発行される追加の clear/put（db.js の実装）を ops に記録した
// 「後」で tx.oncomplete を発火させる（2段目のマイクロタスクに分離）。
function installFakeIndexedDBWithWrites({
  storeNames,
  failAfterOps,
  data = {},
  keyPathByStore = {},
} = {}) {
  const dataMap = new Map(Object.entries(data));
  const keyPathMap = new Map(Object.entries(keyPathByStore));
  const ops = [];
  let tx = null;
  const fakeDb = {
    objectStoreNames: storeNames,
    transaction: vi.fn((names, mode) => {
      tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        mode,
        names,
        // B11: 近似の限界 — 呼び出しを記録するだけで、実 IDB のような onabort 発火・
        // 保留中リクエストの無効化・書き込みロールバックは行わない。preserveKeys 対応ストアが
        // 複数になる変更が入ると、実 IDB では abort されるはずの書き込みをこのフェイクが
        // 通してしまいうる（テスト成功は本番のロールバック保証を意味しない）。
        abort: vi.fn(),
      };
      const pendingGetAll = [];
      tx.objectStore = (name) => ({
        keyPath: keyPathMap.get(name),
        clear: () => ops.push({ op: 'clear', name }),
        put: (record) => ops.push({ op: 'put', name, record }),
        getAll: () => {
          const req = makeRequest();
          ops.push({ op: 'getAll', name, req });
          pendingGetAll.push({ name, req });
          return req;
        },
      });
      queueMicrotask(() => {
        for (const { name, req } of pendingGetAll) {
          req.result = dataMap.get(name) ?? [];
          req.onsuccess?.();
        }
        queueMicrotask(() => {
          if (failAfterOps != null && ops.length >= failAfterOps) {
            tx.error = new Error('simulated failure after partial ops');
            tx.onabort?.();
            return;
          }
          tx.oncomplete?.();
        });
      });
      return tx;
    }),
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => {
        req.result = fakeDb;
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  });
  return { ops, transactionSpy: fakeDb.transaction, getTx: () => tx };
}

// E2: dbClearAll には直接のテスト被覆が無かった（clearLocalData.test.js は db.js を
// モックする方式のため通過しない）。withAllStoresTx への統合前後で挙動が変わっていないことを
// ここで直接検証する。
describe('dbClearAll（withAllStoresTx 共通化 #216 / #219）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('全ストアを1つの readwrite トランザクションで clear する', async () => {
    const { ops, transactionSpy } = installFakeIndexedDBWithWrites({
      storeNames: ['files', 'meta'],
    });
    const { dbClearAll } = await import('./db');

    await dbClearAll();

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy.mock.calls[0][1]).toBe('readwrite');
    expect(ops).toEqual([
      { op: 'clear', name: 'files' },
      { op: 'clear', name: 'meta' },
    ]);
  });

  it('ストアが1つも無い場合は transaction を呼ばない', async () => {
    const { transactionSpy } = installFakeIndexedDBWithWrites({ storeNames: [] });
    const { dbClearAll } = await import('./db');

    await dbClearAll();

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('トランザクション失敗時は reject する', async () => {
    installFakeIndexedDBWithWrites({ storeNames: ['files'], failAfterOps: 1 });
    const { dbClearAll } = await import('./db');

    await expect(dbClearAll()).rejects.toThrow();
  });
});

describe('dbRestoreAllStores（JSON バックアップ復元 #216 / #219）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recordsByStore の内容で各ストアを clear → put する（単一 readwrite トランザクション）', async () => {
    const { ops, transactionSpy } = installFakeIndexedDBWithWrites({
      storeNames: ['files', 'meta'],
    });
    const { dbRestoreAllStores } = await import('./db');

    await dbRestoreAllStores(
      new Map([
        ['files', [{ id: 'f1' }, { id: 'f2' }]],
        ['meta', [{ key: 'fid', value: '1' }]],
      ]),
    );

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy.mock.calls[0][1]).toBe('readwrite');
    expect(ops).toEqual([
      { op: 'clear', name: 'files' },
      { op: 'put', name: 'files', record: { id: 'f1' } },
      { op: 'put', name: 'files', record: { id: 'f2' } },
      { op: 'clear', name: 'meta' },
      { op: 'put', name: 'meta', record: { key: 'fid', value: '1' } },
    ]);
  });

  // B1: recordsByStore が現在の DB ストア全体を覆っていない場合は fail-closed で throw する
  // （tx を開く前に検査する。呼び出し側の「データは復元前の状態のまま」が真であり続けるため）。
  it('recordsByStore が現在の DB ストア全体を覆っていなければ tx を開く前に throw する', async () => {
    const { transactionSpy } = installFakeIndexedDBWithWrites({ storeNames: ['files', 'meta'] });
    const { dbRestoreAllStores } = await import('./db');

    await expect(dbRestoreAllStores(new Map([['files', [{ id: 'f1' }]]]))).rejects.toThrow(/meta/);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('レコードが空配列のストアも clear だけは行う', async () => {
    const { ops } = installFakeIndexedDBWithWrites({ storeNames: ['files'] });
    const { dbRestoreAllStores } = await import('./db');

    await dbRestoreAllStores(new Map([['files', []]]));

    expect(ops).toEqual([{ op: 'clear', name: 'files' }]);
  });

  it('書き込み中に失敗すれば reject し、部分適用を成功として報告しない', async () => {
    installFakeIndexedDBWithWrites({ storeNames: ['files', 'meta'], failAfterOps: 2 });
    const { dbRestoreAllStores } = await import('./db');

    await expect(
      dbRestoreAllStores(
        new Map([
          ['files', [{ id: 'f1' }, { id: 'f2' }]],
          ['meta', [{ key: 'fid', value: '1' }]],
        ]),
      ),
    ).rejects.toThrow();
  });

  // B8: preserveKeys（Map<storeName, Set<key>>）の保証内容は dbRestoreAllStores のコメントを
  // 正本とする。定数化: current/backup の値・put 済みレコードを sonarjs/no-duplicate-string
  // 対策として一箇所にまとめる（同じ文字列リテラルをテストケース間で複製しない）。
  describe('preserveKeys（除外キーの現在値保持 #216 / #219 B8）', () => {
    const CURRENT_DEVICE_RECORD = { key: 'deviceId', value: 'current-device' };
    const BACKUP_FID_RECORD = { key: 'fid', value: 'backup-fid' };

    it('保持対象キーは現在値を維持し、それ以外は incoming の値で上書きする', async () => {
      const { ops } = installFakeIndexedDBWithWrites({
        storeNames: ['meta'],
        data: {
          meta: [CURRENT_DEVICE_RECORD, { key: 'fid', value: 'current-fid-should-be-overwritten' }],
        },
        keyPathByStore: { meta: 'key' },
      });
      const { dbRestoreAllStores } = await import('./db');

      await dbRestoreAllStores(
        new Map([['meta', [{ key: 'deviceId', value: 'backup-device' }, BACKUP_FID_RECORD]]]),
        { preserveKeys: new Map([['meta', new Set(['deviceId'])]]) },
      );

      const putRecords = ops
        .filter((o) => o.op === 'put' && o.name === 'meta')
        .map((o) => o.record);
      const byKey = new Map(putRecords.map((r) => [r.key, r.value]));
      expect(byKey.get('deviceId')).toBe(CURRENT_DEVICE_RECORD.value);
      expect(byKey.get('fid')).toBe(BACKUP_FID_RECORD.value);
    });

    // B8（保証の理由は dbRestoreAllStores のコメントを正本とする）。呼び出し側が除外キーを
    // 含めていない場合でも、現在 DB に該当レコードが無ければ保持分が復元後に新規追加され
    // ないことを検証する（保持分は現在 DB の getAll 結果からのみ作る）。
    it('現在 DB に存在しない保持対象キーは、復元後に追加されない（保持側は現在 DB からしか来ない）', async () => {
      const { ops } = installFakeIndexedDBWithWrites({
        storeNames: ['meta'],
        data: { meta: [] }, // 現在端末に ghUser が無い（未ログイン）
        keyPathByStore: { meta: 'key' },
      });
      const { dbRestoreAllStores } = await import('./db');

      await dbRestoreAllStores(new Map([['meta', [BACKUP_FID_RECORD]]]), {
        preserveKeys: new Map([['meta', new Set(['ghUser'])]]),
      });

      const putRecords = ops
        .filter((o) => o.op === 'put' && o.name === 'meta')
        .map((o) => o.record);
      expect(putRecords.some((r) => r.key === 'ghUser')).toBe(false);
    });

    // B8（理由は dbRestoreAllStores のコメントを正本とする）。
    it('incoming に保持対象キーのレコードが含まれていても、現在 DB の値で上書きする（呼び出し側が除去しなくても保護される）', async () => {
      const { ops } = installFakeIndexedDBWithWrites({
        storeNames: ['meta'],
        data: { meta: [CURRENT_DEVICE_RECORD] },
        keyPathByStore: { meta: 'key' },
      });
      const { dbRestoreAllStores } = await import('./db');

      await dbRestoreAllStores(
        new Map([['meta', [{ key: 'deviceId', value: 'attacker-supplied' }, BACKUP_FID_RECORD]]]),
        { preserveKeys: new Map([['meta', new Set(['deviceId'])]]) },
      );

      const putRecords = ops
        .filter((o) => o.op === 'put' && o.name === 'meta')
        .map((o) => o.record);
      const byKey = new Map(putRecords.map((r) => [r.key, r.value]));
      expect(byKey.get('deviceId')).toBe(CURRENT_DEVICE_RECORD.value);
      // incoming 由来の deviceId put が残っていない（保持分の1回だけ put される）
      expect(putRecords.filter((r) => r.key === 'deviceId')).toHaveLength(1);
    });

    it('保持対象ストアは getAll → clear → incoming put → 保持分 put の順で書き込む', async () => {
      const { ops } = installFakeIndexedDBWithWrites({
        storeNames: ['meta'],
        data: { meta: [CURRENT_DEVICE_RECORD] },
        keyPathByStore: { meta: 'key' },
      });
      const { dbRestoreAllStores } = await import('./db');

      await dbRestoreAllStores(new Map([['meta', [BACKUP_FID_RECORD]]]), {
        preserveKeys: new Map([['meta', new Set(['deviceId'])]]),
      });

      expect(ops.map((o) => o.op)).toEqual(['getAll', 'clear', 'put', 'put']);
      expect(ops[2].record).toEqual(BACKUP_FID_RECORD);
      expect(ops[3].record).toEqual(CURRENT_DEVICE_RECORD);
    });

    it('preserveKeys を渡さないストアは従来どおり getAll を発行せず同期的に clear → put する', async () => {
      const { ops } = installFakeIndexedDBWithWrites({ storeNames: ['files'] });
      const { dbRestoreAllStores } = await import('./db');

      await dbRestoreAllStores(new Map([['files', [{ id: 'f1' }]]]));

      expect(ops.map((o) => o.op)).toEqual(['clear', 'put']);
    });

    // keyPath が文字列でないストア（複合キー・out-of-line キー）に preserveKeys を
    // 指定すると、record[store.keyPath] が常に undefined になり保持対象が1件も拾えない
    // まま「復元成功」してしまう。silent fail-open を防ぐため throw で reject する。
    // run（withAllStoresTx のコールバック）が同期 throw した場合、それ以前に発行済みの
    // リクエストがコミットされて部分適用にならないよう、withAllStoresTx 側で tx.abort() を
    // 呼ぶ必要がある（呼ばなければ実 IndexedDB では既発行の clear/put がコミットされる）。
    it('keyPath が文字列でないストアに preserveKeys を指定すると reject し、tx.abort() を呼ぶ', async () => {
      const { transactionSpy, getTx } = installFakeIndexedDBWithWrites({
        storeNames: ['meta'],
        data: { meta: [] },
        // keyPathByStore を渡さない = store.keyPath が undefined になる
      });
      const { dbRestoreAllStores } = await import('./db');

      await expect(
        dbRestoreAllStores(new Map([['meta', [BACKUP_FID_RECORD]]]), {
          preserveKeys: new Map([['meta', new Set(['deviceId'])]]),
        }),
      ).rejects.toThrow(/meta/);
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(getTx().abort).toHaveBeenCalledTimes(1);
    });
  });
});

describe('dbGetAllStores の abort・部分結果経路（全データバックアップ #216 / #219）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('abort だけが発火する経路（onerror は発火しない）でも reject する', async () => {
    const ctl = installControllableFakeIndexedDB({ storeNames: ['files'] });
    const { dbGetAllStores } = await import('./db');

    const resultPromise = dbGetAllStores();
    await flushMicrotasks();
    ctl.abortTx(new Error('quota exceeded (simulated)'));

    await expect(resultPromise).rejects.toThrow();
  });

  it('一部ストアが成功していても abort されれば部分結果を返さず reject する', async () => {
    const ctl = installControllableFakeIndexedDB({ storeNames: ['files', 'meta'] });
    const { dbGetAllStores } = await import('./db');

    const resultPromise = dbGetAllStores();
    await flushMicrotasks();
    ctl.resolveStore('files', [{ id: 'f1' }]); // files だけ先に成功
    await flushMicrotasks();
    ctl.abortTx(new Error('aborted after partial success (simulated)'));

    await expect(resultPromise).rejects.toThrow();
  });

  it('oncomplete 前には resolve しない（最初の getAll 完了だけで確定しない）', async () => {
    const ctl = installControllableFakeIndexedDB({ storeNames: ['files', 'meta'] });
    const { dbGetAllStores } = await import('./db');

    let settled = false;
    const resultPromise = dbGetAllStores().then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    await flushMicrotasks();

    ctl.resolveStore('files', [{ id: 'f1' }]);
    await flushMicrotasks();
    expect(settled).toBe(false); // files だけ成功した段階ではまだ確定しない

    ctl.resolveStore('meta', [{ key: 'fid', value: '1' }]);
    ctl.completeTx();
    const result = await resultPromise;

    expect(settled).toBe(true);
    expect(result.files).toEqual([{ id: 'f1' }]);
    expect(result.meta).toEqual([{ key: 'fid', value: '1' }]);
  });
});
