import { create } from 'zustand';
import { dbGetAll, dbPut, dbDelete } from '../lib/db';
import {
  normalizeFileMetadata,
  normalizeFolderMeta,
  normalizeKindDefinition,
  normalizeStatusDefinition,
  normalizeWorkSettings,
} from '../lib/metadata/normalizeFileMetadata';

const _dbWriteTimers = Object.create(null);
const _dbPendingWrites = Object.create(null);

function buildIdSets(kindDefs, statusDefs) {
  return {
    kindIdSet: new Set(kindDefs.map((d) => d.id)),
    statusIdSet: new Set(statusDefs.map((d) => d.id)),
  };
}

export const useFileMetadataStore = create((set, get) => ({
  // 辞書データ
  kindDefinitions: [],
  statusDefinitions: [],
  customFieldDefs: [],

  // ファイルごとのメタデータ: { [fileId]: FileMetadataRecord }
  fileMetadataMap: Object.create(null),

  // フォルダごとのメタデータ: { [folderId]: FolderMetadataRecord }
  folderMetaMap: Object.create(null),

  // 作品ごとの設定: { [workId]: WorkSettingsRecord }
  workSettingsMap: Object.create(null),

  isLoaded: false,

  // ── Hydration ─────────────────────────────────────────────────────────────

  hydrate: async () => {
    try {
      // allSettled: 1 ストアの読み込み失敗が kind/status 辞書など他ストアの hydrate を巻き込まない
      const results = await Promise.allSettled([
        dbGetAll('kindDefinitions'),
        dbGetAll('statusDefinitions'),
        dbGetAll('customFieldDefs'),
        dbGetAll('fileMetadata'),
        dbGetAll('folderMeta'),
        dbGetAll('workSettings'),
      ]);
      const [rawKinds, rawStatuses, rawFieldDefs, rawFileMeta, rawFolderMeta, rawWorkSettings] =
        results.map((r, i) => {
          if (r.status === 'fulfilled') return r.value;
          console.warn('[fileMetadataStore] hydrate: store read failed (index', i, ')', r.reason);
          return [];
        });

      const kindDefinitions = rawKinds.map(normalizeKindDefinition).filter(Boolean);
      const statusDefinitions = rawStatuses.map(normalizeStatusDefinition).filter(Boolean);
      const customFieldDefs = Array.isArray(rawFieldDefs)
        ? rawFieldDefs
            .filter(
              (d) =>
                d &&
                typeof d === 'object' &&
                typeof d.id === 'string' &&
                typeof d.label === 'string',
            )
            .map((d) => ({ ...d, archived: d.archived === true }))
        : [];

      const { kindIdSet, statusIdSet } = buildIdSets(kindDefinitions, statusDefinitions);

      const fileMetadataMap = Object.create(null);
      for (const raw of rawFileMeta || []) {
        const normalized = normalizeFileMetadata(raw, {
          kindIdSet,
          statusIdSet,
          fieldDefs: customFieldDefs,
        });
        if (normalized.fileId) fileMetadataMap[normalized.fileId] = normalized;
      }

      const folderMetaMap = Object.create(null);
      for (const raw of rawFolderMeta || []) {
        const normalized = normalizeFolderMeta(raw, { kindIdSet });
        if (normalized.folderId) folderMetaMap[normalized.folderId] = normalized;
      }

      const workSettingsMap = Object.create(null);
      for (const raw of rawWorkSettings || []) {
        const normalized = normalizeWorkSettings(raw);
        if (normalized) workSettingsMap[normalized.id] = normalized;
      }

      set({
        kindDefinitions,
        statusDefinitions,
        customFieldDefs,
        fileMetadataMap,
        folderMetaMap,
        workSettingsMap,
        isLoaded: true,
      });
    } catch (e) {
      console.warn('[fileMetadataStore] hydrate failed', e);
      set({ isLoaded: true });
    }
  },

  // ── FileMetadata ──────────────────────────────────────────────────────────

  getFileMetadata: (fileId) => {
    return get().fileMetadataMap[fileId] ?? null;
  },

  updateFileMetadata: (fileId, updates) => {
    const { fileMetadataMap, kindDefinitions, statusDefinitions, customFieldDefs } = get();
    const existing = fileMetadataMap[fileId];
    const now = Date.now();

    const { kindIdSet, statusIdSet } = buildIdSets(kindDefinitions, statusDefinitions);

    const merged = normalizeFileMetadata(
      {
        ...(existing ?? { fileId, createdAt: now }),
        ...updates,
        fileId,
        updatedAt: now,
        isDirty: true,
      },
      { kindIdSet, statusIdSet, fieldDefs: customFieldDefs },
    );

    set((s) => ({
      fileMetadataMap: Object.assign(Object.create(null), s.fileMetadataMap, { [fileId]: merged }),
    }));
    if (_dbWriteTimers[fileId]) clearTimeout(_dbWriteTimers[fileId]);
    _dbPendingWrites[fileId] = merged;
    _dbWriteTimers[fileId] = setTimeout(() => {
      delete _dbWriteTimers[fileId];
      const record = _dbPendingWrites[fileId];
      delete _dbPendingWrites[fileId];
      if (record)
        dbPut('fileMetadata', record).catch((e) =>
          console.warn('[fileMetadataStore] updateFileMetadata failed', e),
        );
    }, 500);
  },

  ensureFileMetadata: async (fileId, defaults = {}) => {
    const { fileMetadataMap, kindDefinitions, statusDefinitions } = get();
    if (Object.hasOwn(fileMetadataMap, fileId)) return;
    const now = Date.now();
    const { kindIdSet, statusIdSet } = buildIdSets(kindDefinitions, statusDefinitions);
    const record = normalizeFileMetadata(
      {
        fileId,
        workId: null,
        title: '',
        kindId: 20,
        statusId: 10,
        tagIds: [],
        custom: {},
        createdAt: now,
        updatedAt: now,
        isDirty: false,
        ...defaults,
      },
      { kindIdSet, statusIdSet },
    );
    set((s) => ({
      fileMetadataMap: Object.assign(Object.create(null), s.fileMetadataMap, { [fileId]: record }),
    }));
    await dbPut('fileMetadata', record).catch((e) =>
      console.warn('[fileMetadataStore] ensureFileMetadata failed', e),
    );
  },

  deleteFileMetadata: async (fileId) => {
    if (_dbWriteTimers[fileId]) {
      clearTimeout(_dbWriteTimers[fileId]);
      delete _dbWriteTimers[fileId];
      delete _dbPendingWrites[fileId];
    }
    set((s) => {
      const next = Object.assign(Object.create(null), s.fileMetadataMap);
      delete next[fileId];
      return { fileMetadataMap: next };
    });
    await dbDelete('fileMetadata', fileId).catch((e) =>
      console.warn('[fileMetadataStore] deleteFileMetadata failed', e),
    );
  },

  // ── FolderMeta ────────────────────────────────────────────────────────────

  // 保存成否を { ok } で返す。失敗時は state を直前の値へ戻す（呼び出し元が伝播/巻き戻し判断できるよう）。
  updateFolderMeta: async (folderId, updates) => {
    const { folderMetaMap, kindDefinitions } = get();
    const existing = folderMetaMap[folderId];
    const now = Date.now();
    const kindIdSet = new Set(kindDefinitions.map((d) => d.id));
    const merged = normalizeFolderMeta(
      { ...(existing ?? { folderId, createdAt: now }), ...updates, folderId, updatedAt: now },
      { kindIdSet },
    );
    set((s) => ({
      folderMetaMap: Object.assign(Object.create(null), s.folderMetaMap, { [folderId]: merged }),
    }));
    try {
      await dbPut('folderMeta', merged);
      return { ok: true, record: merged };
    } catch (e) {
      console.warn('[fileMetadataStore] updateFolderMeta failed', e);
      set((s) => {
        const next = Object.assign(Object.create(null), s.folderMetaMap);
        if (existing) next[folderId] = existing;
        else delete next[folderId];
        return { folderMetaMap: next };
      });
      return { ok: false, reason: 'フォルダメタデータの保存に失敗しました' };
    }
  },

  deleteFolderMeta: async (folderId) => {
    set((s) => {
      const next = Object.assign(Object.create(null), s.folderMetaMap);
      delete next[folderId];
      return { folderMetaMap: next };
    });
    await dbDelete('folderMeta', folderId).catch((e) =>
      console.warn('[fileMetadataStore] deleteFolderMeta failed', e),
    );
  },

  // ── WorkSettings（作品） ───────────────────────────────────────────────────

  // 作品レコードを作成し IDB へ即時保存する（debounce しない: flush 漏れを新規に作らない）。
  // 保存失敗時は state をロールバックして { ok: false } を返す（失敗を成功扱いにしない）。
  createWorkSettings: async ({ id, label }) => {
    const now = Date.now();
    const record = normalizeWorkSettings({ id, label, createdAt: now, updatedAt: now });
    if (!record) return { ok: false, reason: '無効な作品データです' };
    set((s) => ({
      workSettingsMap: Object.assign(Object.create(null), s.workSettingsMap, {
        [record.id]: record,
      }),
    }));
    try {
      await dbPut('workSettings', record);
      return { ok: true, record };
    } catch (e) {
      console.warn('[fileMetadataStore] createWorkSettings failed', e);
      set((s) => {
        const next = Object.assign(Object.create(null), s.workSettingsMap);
        delete next[record.id];
        return { workSettingsMap: next };
      });
      return { ok: false, reason: '作品の保存に失敗しました' };
    }
  },

  // 作品作成のロールバック（createWork）と、folder 削除で参照されなくなった workSettings の
  // 掃除（deleteFolder、#390）で使う。state と IDB の双方から削除する。
  deleteWorkSettings: async (workId) => {
    set((s) => {
      const next = Object.assign(Object.create(null), s.workSettingsMap);
      delete next[workId];
      return { workSettingsMap: next };
    });
    await dbDelete('workSettings', workId).catch((e) =>
      console.warn('[fileMetadataStore] deleteWorkSettings failed', e),
    );
  },

  // ── KindDefinitions ───────────────────────────────────────────────────────

  setKindDefinitions: async (defs) => {
    const normalized = defs.map(normalizeKindDefinition).filter(Boolean);
    set({ kindDefinitions: normalized });
    for (const d of normalized) await dbPut('kindDefinitions', d).catch(console.warn);
  },

  // ── StatusDefinitions ─────────────────────────────────────────────────────

  setStatusDefinitions: async (defs) => {
    const normalized = defs.map(normalizeStatusDefinition).filter(Boolean);
    set({ statusDefinitions: normalized });
    for (const d of normalized) await dbPut('statusDefinitions', d).catch(console.warn);
  },

  // ── CustomFieldDefs ───────────────────────────────────────────────────────

  setCustomFieldDefs: async (defs) => {
    const safe = Array.isArray(defs)
      ? defs
          .filter(
            (d) =>
              d && typeof d === 'object' && typeof d.id === 'string' && typeof d.label === 'string',
          )
          .map((d) => ({ ...d, archived: d.archived === true }))
      : [];
    set({ customFieldDefs: safe });
    for (const d of safe) await dbPut('customFieldDefs', d).catch(console.warn);
  },

  flushPendingWrites: async () => {
    const promises = Object.entries(_dbWriteTimers).map(([fileId, timer]) => {
      clearTimeout(timer);
      delete _dbWriteTimers[fileId];
      const record = _dbPendingWrites[fileId];
      delete _dbPendingWrites[fileId];
      return record ? dbPut('fileMetadata', record).catch(console.warn) : Promise.resolve();
    });
    await Promise.all(promises);
  },
}));

// セレクター用エクスポート
export const metadataActions = {
  hydrate: () => useFileMetadataStore.getState().hydrate(),
  ensureFileMetadata: (fileId, defaults) =>
    useFileMetadataStore.getState().ensureFileMetadata(fileId, defaults),
  updateFileMetadata: (fileId, updates) =>
    useFileMetadataStore.getState().updateFileMetadata(fileId, updates),
  deleteFileMetadata: (fileId) => useFileMetadataStore.getState().deleteFileMetadata(fileId),
  deleteFolderMeta: (folderId) => useFileMetadataStore.getState().deleteFolderMeta(folderId),
  updateFolderMeta: (folderId, updates) =>
    useFileMetadataStore.getState().updateFolderMeta(folderId, updates),
  createWorkSettings: (input) => useFileMetadataStore.getState().createWorkSettings(input),
  deleteWorkSettings: (workId) => useFileMetadataStore.getState().deleteWorkSettings(workId),
  flushPendingWrites: () => useFileMetadataStore.getState().flushPendingWrites(),
};
