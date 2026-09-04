export const DB_NAME = 'novel-ide-db';
export const DB_VERSION = 4; // not-a-threshold

let _db = null;

function idbReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function migrateFromLocalStorage(tx) {
  try {
    const ls = window.localStorage;
    const filesStore = tx.objectStore('files');
    const settingsStore = tx.objectStore('settings');
    const metaStore = tx.objectStore('meta');
    const annosStore = tx.objectStore('annotations');
    const now = Date.now();

    let files = [];
    try {
      const raw = ls.getItem('ide_files');
      if (raw) files = JSON.parse(raw);
    } catch {}

    for (const f of files) {
      filesStore.put({
        id: f.id,
        name: f.name,
        content: f.content,
        github: f.github || null,
        createdAt: f.createdAt || now,
        updatedAt: f.updatedAt || now,
        isDirty: Boolean(f.isDirty),
      });
      try {
        const annos = JSON.parse(ls.getItem(`ide_annos_${f.id}`) || '[]');
        if (annos.length) annosStore.put({ fileId: f.id, list: annos, updatedAt: now });
      } catch {}
    }

    const settingsMigrations = [
      ['theme', 'ide_theme', 'dark'],
      ['settings', 'ide_settings_v2', null],
      ['colors', 'ide_colors', null],
      ['sidebarSide', 'ide_sb_side', 'left'],
      ['showLineNumbers', 'ide_linenos', false],
      ['wgoal', 'ide_wgoal', null],
      ['tags', 'ide_tags', null],
      ['rules', 'ide_rules', null],
    ];
    for (const [key, lsKey, def] of settingsMigrations) {
      try {
        const raw = ls.getItem(lsKey);
        if (raw !== null) settingsStore.put({ key, value: JSON.parse(raw) });
        else if (def !== null) settingsStore.put({ key, value: def });
      } catch {}
    }

    try {
      const fid = ls.getItem('ide_fid');
      if (fid) metaStore.put({ key: 'fid', value: JSON.parse(fid) });
    } catch {}
    try {
      const ghUser = ls.getItem('ide_gh_user');
      if (ghUser) metaStore.put({ key: 'ghUser', value: JSON.parse(ghUser) });
    } catch {}

    metaStore.put({ key: 'deviceId', value: crypto.randomUUID() });
    metaStore.put({ key: 'migrated_from_ls', value: true });
  } catch (e) {
    console.warn('[db] localStorage migration failed', e);
  }
}

// seedMetadataDefaults（onupgradeneeded 用）と restore.js（A2: resolveDictionaryDefinitions）が
// 共有する既定辞書の定義元。理由は restore.js 側のコメントを正本とする。新しい既定辞書を
// ここ以外に書き起こさないこと。
export const DEFAULT_KIND_DEFINITIONS = [
  {
    id: 10,
    key: 'body',
    label: '本文',
    order: 10,
    isSystem: true,
    archived: false,
    flags: [
      'editable',
      'mainPaneAllowed',
      'referencePaneAllowed',
      'exportable',
      'wordCountTarget',
      'searchTarget',
      'proofreadTarget',
      'diffTarget',
    ],
  },
  {
    id: 20,
    key: 'raw',
    label: '未整理',
    order: 20,
    isSystem: true,
    archived: false,
    flags: [
      'editable',
      'mainPaneAllowed',
      'referencePaneAllowed',
      'searchTarget',
      'diffTarget',
      'rawLike',
    ],
  },
  {
    id: 30,
    key: 'setting',
    label: '設定',
    order: 30,
    isSystem: true,
    archived: false,
    flags: [
      'editable',
      'referencePaneAllowed',
      'referencePanePreferred',
      'searchTarget',
      'diffTarget',
    ],
  },
  {
    id: 40,
    key: 'reference',
    label: '参照資料',
    order: 40,
    isSystem: true,
    archived: false,
    flags: ['referencePaneAllowed', 'referencePanePreferred', 'searchTarget', 'readOnlyDefault'],
  },
];

export const DEFAULT_STATUS_DEFINITIONS = [
  {
    id: 10,
    key: 'raw',
    label: '未整理',
    order: 10,
    nextStatusIds: [20],
    isTerminal: false,
    archived: false,
  },
  {
    id: 20,
    key: 'draft',
    label: '草稿',
    order: 20,
    nextStatusIds: [30],
    isTerminal: false,
    archived: false,
  },
  {
    id: 30,
    key: 'revision',
    label: '改稿中',
    order: 30,
    nextStatusIds: [40],
    isTerminal: false,
    archived: false,
  },
  {
    id: 40,
    key: 'done',
    label: '完成',
    order: 40,
    nextStatusIds: [],
    isTerminal: true,
    archived: false,
  },
];

function seedMetadataDefaults(tx) {
  try {
    const kindStore = tx.objectStore('kindDefinitions');
    for (const kind of DEFAULT_KIND_DEFINITIONS) kindStore.put(kind);

    const statusStore = tx.objectStore('statusDefinitions');
    for (const status of DEFAULT_STATUS_DEFINITIONS) statusStore.put(status);
    // 既存ファイルへの fileMetadata 生成は AppContext の ensureFileMetadata に委ねる
  } catch (e) {
    console.warn('[db] seedMetadataDefaults failed', e);
  }
}

export function getDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;
      // 新ストア追加時に backup / restore 側で必要な更新一覧は docs/data-model/INVARIANTS.md #8 を参照。
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('annotations'))
        db.createObjectStore('annotations', { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains('settings'))
        db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('folders'))
        db.createObjectStore('folders', { keyPath: 'id' });

      // v3: メタデータ基盤ストア (#171)
      if (!db.objectStoreNames.contains('fileMetadata'))
        db.createObjectStore('fileMetadata', { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains('folderMeta'))
        db.createObjectStore('folderMeta', { keyPath: 'folderId' });
      if (!db.objectStoreNames.contains('kindDefinitions'))
        db.createObjectStore('kindDefinitions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('statusDefinitions'))
        db.createObjectStore('statusDefinitions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('customFieldDefs'))
        db.createObjectStore('customFieldDefs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workSettings'))
        db.createObjectStore('workSettings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workspaceSettings'))
        db.createObjectStore('workspaceSettings', { keyPath: 'key' });

      // v4: 同期状態の同一性ストア (#610)。files/fileMetadata の isDirty とは独立
      // （docs/data-model/INVARIANTS.md #3）。レコード形状: { id, adoptedHash, adoptedAt }。
      if (!db.objectStoreNames.contains('syncState'))
        db.createObjectStore('syncState', { keyPath: 'id' });

      if (e.oldVersion === 0) migrateFromLocalStorage(tx);
      if (e.oldVersion < 3) seedMetadataDefaults(tx);
    };
    request.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function dbGet(store, key) {
  const db = await getDb();
  return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function dbPut(store, record) {
  const db = await getDb();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(record));
}

export async function dbGetAll(store) {
  const db = await getDb();
  return idbReq(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function dbDelete(store, key) {
  const db = await getDb();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

// 全ストアを1つのトランザクションで操作する共通ヘルパー。
// dbClearAll（readwrite）/ dbGetAllStores（readonly）/ dbRestoreAllStores（readwrite）の
// 3箇所が同型の「getDb() → ストア列挙 → 空ガード → tx 生成 → oncomplete/onerror/onabort」を
// 個別に持っていたため統合する（JSON バックアップ復元 #216 / #219）。run はトランザクション
// 内で同期的にリクエストを発行するコールバック（tx を越えて await しない）。
// 対象は常に db.objectStoreNames 全体（ストア追加に自動で追従する。部分適用オプションは持たない）。
async function withAllStoresTx(mode, run) {
  const db = await getDb();
  const stores = Array.from(db.objectStoreNames);
  // db.transaction([]) は InvalidAccessError を投げるため空ガードが要る。
  if (stores.length === 0) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    try {
      run(tx, stores);
    } catch (e) {
      // run が同期 throw すると、それ以前に発行済みのリクエスト（clear/put）が
      // tx を abort しない限りコミットされ、部分適用になる（呼び出し側の
      // 「復元前の状態のまま」という報告が嘘になる）。abort 自体が失敗しうる
      // （既に abort/commit 済み等）ため握りつぶし、元の例外を優先して rethrow する。
      // 以降 tx.onabort が発火して reject(tx.error) が呼ばれても、この Promise は
      // 下の rethrow で既に settled のため no-op。
      try {
        tx.abort();
      } catch {}
      throw e;
    }
  });
}

// 全ストアを1トランザクションで clear する（ローカルデータ全削除 #279）。
// objectStoreNames を使うためストア追加に追従し列挙不要。deleteDatabase は開いている
// 接続でブロックされうるため避ける。
export async function dbClearAll() {
  await withAllStoresTx('readwrite', (tx, stores) => {
    for (const s of stores) tx.objectStore(s).clear();
  });
}

// 全ストアを1つの readonly トランザクションで読み出す（全データバックアップ #216 / #219）。
// ストアごとに dbGetAll を個別に呼ぶと、読み出し中の書き込みでストア間の内容が
// 不整合になりうるため、dbClearAll と同型の単一トランザクションパターンを踏襲する。
// objectStoreNames から動的に取得するためストア追加に追従する。
export async function dbGetAllStores() {
  const collected = new Map();
  await withAllStoresTx('readonly', (tx, stores) => {
    for (const s of stores) {
      const req = tx.objectStore(s).getAll();
      req.onsuccess = () => {
        collected.set(s, req.result);
      };
    }
  });
  return Object.assign(Object.create(null), Object.fromEntries(collected));
}

// recordsByStore（Map<storeName, record[]>）の内容で全ストアを置き換える
// （JSON バックアップからの復元 #216 / #219）。ストアごとに clear → put を発行し、
// tx.oncomplete のみを成功シグナルにする単一 readwrite トランザクションで行う。
// 途中で失敗すれば tx が abort/reject され、呼び出し側は成功シグナルを受け取らない
// （実 IndexedDB は abort 時に書き込みをロールバックするため新旧混在が残らない）。
//
// fail-closed（減算レビュー所見 S2）: recordsByStore は現在の DB ストア全体を必ず覆っていなければ
// ならない。欠けているストアがあれば tx を開く前に throw する（呼び出し側が「データは復元前の
// 状態のまま」と報告できるのは、tx が一切開かれていない場合に限られるため）。この検査は
// withAllStoresTx を呼ぶ前に自前で行う（getDb() はメモ化されているため、ここでの getDb() と
// withAllStoresTx 内の getDb() は同一ハンドルを返す。二重呼び出しにはならない）。
//
// preserveKeys（Map<storeName, Set<key>>）を渡すと、そのストアの中で primary key が集合に
// 含まれるレコードは、incoming（recordsByStore）の値ではなく現在 DB の値を保持する。
// どのキーを保持するかは呼び出し側（restore.js の META_EXCLUDED_KEYS 等）が決める—
// db.js はストア名・キーのリテラルを持たない汎用ヘルパーに留める。
// 保証（B8）: incoming から保持対象キーのレコードを取り除くのは db.js 自身が行う。
// 呼び出し側が事前に取り除き忘れても、保持対象キーは常に現在 DB の値で上書きされる
// （関数名どおりの保護を実装で担保し、コメントだけの契約にしない）。
export async function dbRestoreAllStores(recordsByStore, { preserveKeys } = {}) {
  const db = await getDb();
  const missing = Array.from(db.objectStoreNames).filter((s) => !recordsByStore.has(s));
  if (missing.length > 0) {
    throw new Error(
      `dbRestoreAllStores: recordsByStore が現在の DB ストア全体を覆っていません（欠けているストア: ${missing.join(', ')}）`,
    );
  }
  await withAllStoresTx('readwrite', (tx, stores) => {
    for (const s of stores) {
      const store = tx.objectStore(s);
      const incoming = recordsByStore.get(s) ?? [];
      const keysToPreserve = preserveKeys?.get(s);
      if (keysToPreserve && keysToPreserve.size > 0) {
        // fail-closed: 複合キー・out-of-line キーのストアでは keyPath が文字列でなく、
        // record[store.keyPath] が常に undefined になって保持対象が1件も拾えないまま
        // 「復元成功」してしまう。同期アイデンティティ（deviceId 等）を守る保持なので
        // 静かに失敗させず throw する。
        if (typeof store.keyPath !== 'string') {
          throw new Error(
            `dbRestoreAllStores: ストア "${s}" は keyPath が文字列でない（実際: ${String(store.keyPath)}）ため preserveKeys を適用できません`,
          );
        }
        // 保持対象ストア: 現在値を読んでから clear → incoming を put → 保持分を put。
        // 同一 tx 内で onsuccess から新規リクエストを発行するのは有効（リクエストが
        // 発行され続ける限り tx は生きる）。
        const req = store.getAll();
        req.onsuccess = () => {
          const preserved = (req.result ?? []).filter((record) =>
            keysToPreserve.has(record[store.keyPath]),
          );
          store.clear();
          // 保持対象キーの incoming レコードは put しない（B8。理由は本関数冒頭のコメント参照）。
          const filteredIncoming = incoming.filter(
            (record) => !keysToPreserve.has(record?.[store.keyPath]),
          );
          for (const record of filteredIncoming) store.put(record);
          for (const record of preserved) store.put(record);
        };
      } else {
        store.clear();
        for (const record of incoming) store.put(record);
      }
    }
  });
}

export const WORD_COUNT_SETTINGS_KEYS = Object.freeze({
  globalGoal: 'wgoal',
  fileGoals: 'wgoalsByFile',
  folderGoals: 'wgoalsByFolder',
});

const WORD_COUNT_MIGRATION_META_KEY = 'migrated_word_count_settings_v1';

function parsePositiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMap(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function migrateWordCountSettingsFromLocalStorageOnce() {
  const migrated = await dbGet('meta', WORD_COUNT_MIGRATION_META_KEY);
  if (migrated?.value) return;

  let globalRaw, fileRaw, folderRaw;
  try {
    /* eslint-disable no-restricted-globals -- 旧 localStorage キーからのマイグレーション読み取り */
    globalRaw = localStorage.getItem('ide_wgoal');
    fileRaw = localStorage.getItem('ide_wgoals_by_file');
    folderRaw = localStorage.getItem('ide_wgoals_by_folder');
    /* eslint-enable no-restricted-globals */
  } catch {
    // localStorage が使用不可（SecurityError 等）の場合はスキップして完了フラグを立てる
    await dbPut('meta', { key: WORD_COUNT_MIGRATION_META_KEY, value: true });
    return;
  }

  const hasLegacyKeys = globalRaw !== null || fileRaw !== null || folderRaw !== null;

  if (!hasLegacyKeys) {
    await dbPut('meta', { key: WORD_COUNT_MIGRATION_META_KEY, value: true });
    return;
  }

  // legacy キーが存在する場合はパース失敗時もデフォルト値で DB を上書きする
  // （旧挙動と整合させ、DB に残る stale な値が復活するのを防ぐ）
  if (globalRaw !== null) {
    await dbPut('settings', {
      key: WORD_COUNT_SETTINGS_KEYS.globalGoal,
      value: parsePositiveNumber(globalRaw) ?? 2000,
    });
  }
  if (fileRaw !== null) {
    await dbPut('settings', {
      key: WORD_COUNT_SETTINGS_KEYS.fileGoals,
      value: parseMap(fileRaw) ?? {},
    });
  }
  if (folderRaw !== null) {
    await dbPut('settings', {
      key: WORD_COUNT_SETTINGS_KEYS.folderGoals,
      value: parseMap(folderRaw) ?? {},
    });
  }

  /* eslint-disable no-restricted-globals -- マイグレーション完了後の旧キー削除 */
  try {
    localStorage.removeItem('ide_wgoal');
  } catch {}
  try {
    localStorage.removeItem('ide_wgoals_by_file');
  } catch {}
  try {
    localStorage.removeItem('ide_wgoals_by_folder');
  } catch {}
  /* eslint-enable no-restricted-globals */
  await dbPut('meta', { key: WORD_COUNT_MIGRATION_META_KEY, value: true });
}
